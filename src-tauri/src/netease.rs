use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    EnumProcessModulesEx, GetModuleBaseNameW, GetModuleInformation, LIST_MODULES_ALL, MODULEINFO,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

const CLOCK_PATTERN: [Option<u8>; 12] = [
    Some(0xf2), Some(0x0f), Some(0x11), Some(0x3d), None, None, None, None,
    Some(0xf2), Some(0x0f), Some(0x11), Some(0x35),
];
const MAX_MODULE_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Copy)]
struct NeteaseClock {
    process_id: u32,
    address: usize,
}

static CLOCK: OnceLock<Mutex<Option<NeteaseClock>>> = OnceLock::new();

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn open_process(process_id: u32) -> Option<ProcessHandle> {
    unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        )
        .ok()
        .map(ProcessHandle)
    }
}

fn read_memory(handle: HANDLE, address: usize, buffer: &mut [u8]) -> bool {
    let mut bytes_read = 0;
    unsafe {
        ReadProcessMemory(
            handle,
            address as *const c_void,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            Some(&mut bytes_read),
        )
        .is_ok()
            && bytes_read == buffer.len()
    }
}

fn clock_instruction_offset(module: &[u8]) -> Option<usize> {
    module.windows(CLOCK_PATTERN.len()).position(|window| {
        CLOCK_PATTERN
            .iter()
            .zip(window)
            .all(|(expected, actual)| expected.is_none_or(|value| value == *actual))
    })
}

fn clock_address(module_base: usize, module: &[u8]) -> Option<usize> {
    let instruction = clock_instruction_offset(module)?;
    let displacement = i32::from_le_bytes(module[instruction + 4..instruction + 8].try_into().ok()?);
    module_base
        .checked_add(instruction + 8)?
        .checked_add_signed(displacement as isize)
}

fn netease_process_ids() -> Vec<u32> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let snapshot = ProcessHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
        return Vec::new();
    }

    let mut process_ids = Vec::new();
    loop {
        let name_len = entry
            .szExeFile
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..name_len])
            .eq_ignore_ascii_case("cloudmusic.exe")
        {
            process_ids.push(entry.th32ProcessID);
        }
        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }
    process_ids
}

fn find_clock() -> Option<NeteaseClock> {
    for process_id in netease_process_ids() {
        let Some(process) = open_process(process_id) else {
            continue;
        };
        let mut modules = [HMODULE::default(); 512];
        let mut module_bytes = 0;
        if unsafe {
            EnumProcessModulesEx(
                process.0,
                modules.as_mut_ptr(),
                size_of_val(&modules) as u32,
                &mut module_bytes,
                LIST_MODULES_ALL,
            )
        }
        .is_err()
        {
            continue;
        }

        for module in modules
            .into_iter()
            .take(module_bytes as usize / size_of::<HMODULE>())
        {
            let mut name = [0u16; 260];
            let name_len = unsafe { GetModuleBaseNameW(process.0, Some(module), &mut name) } as usize;
            if name_len == 0
                || !String::from_utf16_lossy(&name[..name_len]).eq_ignore_ascii_case("cloudmusic.dll")
            {
                continue;
            }

            let mut info = MODULEINFO::default();
            if unsafe {
                GetModuleInformation(
                    process.0,
                    module,
                    &mut info,
                    size_of::<MODULEINFO>() as u32,
                )
            }
            .is_err()
            {
                continue;
            }
            let module_size = info.SizeOfImage as usize;
            if module_size == 0 || module_size > MAX_MODULE_BYTES {
                continue;
            }
            let module_base = info.lpBaseOfDll as usize;
            let mut image = vec![0u8; module_size];
            if !read_memory(process.0, module_base, &mut image) {
                continue;
            }
            if let Some(address) = clock_address(module_base, &image) {
                return Some(NeteaseClock {
                    process_id,
                    address,
                });
            }
        }
    }
    None
}

fn read_clock(clock: NeteaseClock) -> Option<i64> {
    let process = open_process(clock.process_id)?;
    let mut bytes = [0u8; 8];
    if !read_memory(process.0, clock.address, &mut bytes) {
        return None;
    }
    let seconds = f64::from_le_bytes(bytes);
    (seconds.is_finite() && (0.0..=604_800.0).contains(&seconds))
        .then_some((seconds * 1_000.0).round() as i64)
}

pub fn current_position_ms() -> Option<i64> {
    let mut cached = CLOCK.get_or_init(|| Mutex::new(None)).lock().ok()?;
    if let Some(position) = cached.and_then(read_clock) {
        return Some(position);
    }
    *cached = find_clock();
    cached.and_then(read_clock)
}

#[cfg(test)]
mod tests {
    use super::{clock_address, clock_instruction_offset};

    #[test]
    fn locates_netease_clock_instruction_and_resolves_its_address() {
        let mut image = vec![0u8; 64];
        image[20..32].copy_from_slice(&[
            0xf2, 0x0f, 0x11, 0x3d, 0x20, 0x00, 0x00, 0x00, 0xf2, 0x0f, 0x11, 0x35,
        ]);
        assert_eq!(clock_instruction_offset(&image), Some(20));
        assert_eq!(clock_address(0x1000, &image), Some(0x103c));
    }

    #[test]
    fn rejects_images_without_the_netease_clock_instruction() {
        assert_eq!(clock_instruction_offset(&[0u8; 64]), None);
    }

}
