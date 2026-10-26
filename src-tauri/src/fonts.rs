use std::collections::HashSet;
use serde::Serialize;
use windows::core::{BOOL, PCWSTR, w};
use windows::Win32::Graphics::DirectWrite::{
    DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteLocalizedStrings,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub family: String,
    pub display_name: String,
    pub aliases: Vec<String>,
}

fn localized_string(names: &IDWriteLocalizedStrings, index: u32) -> windows::core::Result<String> {
    let length = unsafe { names.GetStringLength(index)? } as usize;
    let mut buffer = vec![0u16; length + 1];
    unsafe { names.GetString(index, &mut buffer)?; }
    Ok(String::from_utf16_lossy(&buffer[..length]))
}

fn locale_index(names: &IDWriteLocalizedStrings, locale: PCWSTR) -> Option<u32> {
    let mut index = 0;
    let mut exists = BOOL(0);
    unsafe { names.FindLocaleName(locale, &mut index, &mut exists).ok()?; }
    exists.as_bool().then_some(index)
}

pub fn system_fonts() -> Result<Vec<SystemFont>, String> {
    let factory: IDWriteFactory = unsafe { DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) }
        .map_err(|error| error.to_string())?;
    let mut collection = None;
    unsafe { factory.GetSystemFontCollection(&mut collection, true) }
        .map_err(|error| error.to_string())?;
    let collection = collection.ok_or("无法读取 Windows 字体列表")?;
    let mut fonts = Vec::new();
    let mut seen = HashSet::new();
    for index in 0..unsafe { collection.GetFontFamilyCount() } {
        let Ok(family) = (unsafe { collection.GetFontFamily(index) }) else { continue; };
        let Ok(names) = (unsafe { family.GetFamilyNames() }) else { continue; };
        let Ok(family) = localized_string(&names, locale_index(&names, w!("en-us")).unwrap_or(0)) else { continue; };
        if family.is_empty() || family.starts_with('@') || !seen.insert(family.to_lowercase()) { continue; }
        let display_name = locale_index(&names, w!("zh-cn"))
            .and_then(|index| localized_string(&names, index).ok()).unwrap_or_else(|| family.clone());
        let mut aliases: Vec<_> = (0..unsafe { names.GetCount() })
            .filter_map(|index| localized_string(&names, index).ok()).collect();
        aliases.sort();
        aliases.dedup();
        fonts.push(SystemFont { family, display_name, aliases });
    }
    if fonts.is_empty() { return Err("Windows 未返回可用字体".to_string()); }
    fonts.sort_by_key(|font| font.display_name.to_lowercase());
    Ok(fonts)
}

#[cfg(test)]
mod tests {
    #[test]
    fn font_catalog_preserves_complete_names_and_localized_aliases() {
        let fonts = super::system_fonts().expect("DirectWrite system collection should be readable");
        assert!(fonts.len() > 10);
        assert!(fonts.iter().all(|font| !font.family.is_empty() && font.aliases.contains(&font.family)));
        assert!(!fonts.iter().any(|font| font.family == "Segoe UI Variable Display Semib" || font.family == "Segoe UI Variable Display Semil"));
        println!("DirectWrite found {} font families", fonts.len());
        println!("{} complete names exceed the old 31-character limit", fonts.iter().filter(|font| font.family.encode_utf16().count() > 31).count());
        if let Ok(path) = std::env::var("RIVERXILEE_FONT_TEST_EXPORT") {
            std::fs::write(path, serde_json::to_string(&fonts).unwrap()).expect("font test catalog should be writable");
        }
        for font in fonts.iter().filter(|font| font.family.starts_with("Segoe UI Variable")) {
            println!("complete family: {}", font.family);
        }
    }
}
