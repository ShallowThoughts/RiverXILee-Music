// KuGou CEF profile, referenced from BrimDeck KugouPatch (Apache-2.0),
// originally Metabox-Nexus-PlayerCap (Copyright (c) 2026 VTB-LINK, MIT).
// No writes to a live image: locate every unique site, prepare a copy, verify,
// and let the owner install it only after a full backup and explicit consent.
use std::{fs::File, io::{Read, Seek, SeekFrom, Write}, path::Path};
use sha2::{Digest, Sha256};

const SITES: [(&str, &str, &str, &str); 9] = [
    ("00", "C706AAAAAAAA", "C706C92F0000", "0FB6431784C048"),
    ("4889F2", "E896A9E9FC", "9090909090", "813EFEFF0000"),
    ("813EFEFF0000", "0F8796010000", "909090909090", "84C0"),
    ("", "0F848E010000", "909090909090", "488D8C2400010000"),
    ("", "8B957C010000", "BAC92F000090", "8D8200FCFFFF3DFF"),
    ("FD84C0", "0F8470010000", "909090909090", "4C8D7C247C"),
    ("7C", "41C707AAAAAAAA", "41C707C92F0000", "48B8AAAAAAAA"),
    ("", "E8F62EB7FD", "9090909090", "418B1F8D8B00FCFFFF"),
    ("", "0F44DA", "909090", "807F1700790A488B4C2460"),
];
const CHUNK: usize = 1024 * 1024;
fn hex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect() }
#[derive(Debug, PartialEq)]
pub enum State { Original, Patched }
#[derive(Debug)]
pub struct Site { pub offset: u64, pub original: Vec<u8>, pub patched: Vec<u8> }

pub fn locate(file: &mut (impl Read + Seek)) -> Result<(State, Vec<Site>), String> {
    let patterns: Vec<_> = SITES.iter().flat_map(|(pre, a, b, post)| [hex(&format!("{pre}{a}{post}")), hex(&format!("{pre}{b}{post}"))]).collect();
    let overlap = patterns.iter().map(Vec::len).max().unwrap() - 1;
    let mut seen = vec![Vec::new(); patterns.len()];
    let mut buffer = vec![0u8; CHUNK]; let mut kept = 0; let mut base = 0u64;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    loop {
        let mut filled = kept;
        while filled < CHUNK {
            let n = file.read(&mut buffer[filled..]).map_err(|e| e.to_string())?;
            if n == 0 { break; } filled += n;
        }
        for (index, pattern) in patterns.iter().enumerate() {
            let from = kept.saturating_sub(pattern.len() - 1);
            if filled < pattern.len() || from > filled - pattern.len() { continue; }
            let finder = memchr::memmem::Finder::new(pattern);
            let mut start = from;
            while seen[index].len()<2 {
                let Some(found) = finder.find(&buffer[start..filled]) else { break; };
                let at = start + found; seen[index].push(base + at as u64); start = at+1;
            }
        }
        if filled < CHUNK { break; }
        buffer.copy_within(filled-overlap..filled, 0);
        base += (filled-overlap) as u64; kept = overlap;
    }
    let mut sites = Vec::new(); let mut patched_count = 0;
    for (i, (prefix, a, b, _)) in SITES.iter().enumerate() {
        let (at, patched) = match (seen[i*2].as_slice(), seen[i*2+1].as_slice()) {
            ([at], []) => (*at, false), ([], [at]) => (*at, true),
            _ => return Err("此酷狗内核版本未通过全部 9 处唯一特征校验，未修改文件".into()),
        };
        patched_count += usize::from(patched);
        sites.push(Site { offset: at + (prefix.len()/2) as u64, original: hex(a), patched: hex(b) });
    }
    // Do not take over changes made by another tool or an interrupted unknown patch.
    if patched_count != 0 && patched_count != SITES.len() { return Err("酷狗内核存在部分修改；请先用原工具恢复或修复酷狗，未继续修改".into()); }
    for (i, a) in sites.iter().enumerate() {
        for b in &sites[i+1..] {
            if a.offset < b.offset + b.original.len() as u64 && b.offset < a.offset + a.original.len() as u64 { return Err("酷狗特征位置重叠，已拒绝修改".into()); }
        }
    }
    Ok((if patched_count == 0 { State::Original } else { State::Patched }, sites))
}
pub fn apply(file: &mut File) -> Result<(), String> {
    let (state, sites) = locate(file)?;
    if state != State::Original { return Err("文件已被修改，未重复应用兼容修改".into()); }
    for site in sites { file.seek(SeekFrom::Start(site.offset)).map_err(|e| e.to_string())?; file.write_all(&site.patched).map_err(|e| e.to_string())?; }
    file.sync_all().map_err(|e| e.to_string())?;
    if locate(file)?.0 != State::Patched { return Err("兼容副本校验失败，原文件保持不变".into()); }
    Ok(())
}
pub fn hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new(); let mut chunk = [0u8; 65536];
    loop { let n = file.read(&mut chunk).map_err(|e| e.to_string())?; if n == 0 { break; } digest.update(&chunk[..n]); }
    Ok(format!("{:x}", digest.finalize()))
}
#[cfg(test)]
pub(super) mod tests {
    use super::*; use std::io::Cursor;
    pub(crate) fn fixture(patched: bool) -> Vec<u8> {
        let mut bytes = vec![0x55; CHUNK + 4096];
        for (i, (pre,a,b,post)) in SITES.iter().enumerate() {
            let pattern = hex(&format!("{pre}{}{post}", if patched { b } else { a }));
            let start = if i == 0 { CHUNK - 4 } else { i*128 };
            bytes[start..start+pattern.len()].copy_from_slice(&pattern);
        } bytes
    }
    #[test] fn finds_unique_sites_across_chunks_and_changes_only_cores() {
        let original = fixture(false); let mut cursor = Cursor::new(original.clone());
        let (state, sites) = locate(&mut cursor).unwrap(); assert_eq!(state, State::Original);
        let mut patched = original.clone(); for site in &sites { patched[site.offset as usize..site.offset as usize+site.patched.len()].copy_from_slice(&site.patched); }
        assert_eq!(patched, fixture(true)); assert_eq!(locate(&mut Cursor::new(patched)).unwrap().0, State::Patched);
        assert_eq!(sites.len(), 9);
    }
    #[test] fn rejects_missing_duplicate_and_partial_changes() {
        assert!(locate(&mut Cursor::new(vec![0u8; 128])).is_err());
        let mut duplicate = fixture(false); let (pre,a,_,post) = SITES[0]; duplicate.extend(hex(&format!("{pre}{a}{post}")));
        assert!(locate(&mut Cursor::new(duplicate)).is_err());
        let mut partial = fixture(false); let (_,sites) = locate(&mut Cursor::new(partial.clone())).unwrap();
        let site = &sites[0]; partial[site.offset as usize..site.offset as usize+site.patched.len()].copy_from_slice(&site.patched);
        assert!(locate(&mut Cursor::new(partial)).is_err());
    }
    #[test] #[ignore = "read-only compatibility inspection of an explicitly named local DLL"]
    fn live_profile() {
        let path = std::env::var("RIVER_KUGOU_LIBRARY").expect("explicit path");
        let mut file = File::open(path).unwrap();
        println!("KuGou CEF profile: {:?}", locate(&mut file).map(|(state, sites)| (state, sites.len())));
    }
}
