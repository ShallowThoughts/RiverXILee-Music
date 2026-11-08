use std::collections::BTreeSet;

// Only qualifiers, not an arbitrary substring such as "Live Forever", define a recording version.
pub(super) fn version_tags(title: &str) -> BTreeSet<&'static str> {
    let mut qualifiers = String::new();
    let mut depth = 0_u32;
    for c in title.chars() {
        if matches!(c, '(' | '（' | '[' | '【') {
            depth += 1;
            qualifiers.push(' ');
        } else if matches!(c, ')' | '）' | ']' | '】') {
            depth = depth.saturating_sub(1);
            qualifiers.push(' ');
        } else if depth > 0 {
            qualifiers.push(c);
        }
    }
    for separator in [" - ", " — ", " · "] {
        if let Some((_, suffix)) = title.rsplit_once(separator) {
            qualifiers.push(' ');
            qualifiers.push_str(suffix);
        }
    }
    let qualifiers = qualifiers.to_lowercase();
    let words = qualifiers
        .split(|c: char| !c.is_alphanumeric())
        .collect::<Vec<_>>();
    let mut tags = BTreeSet::new();
    for (tag, ascii, chinese) in [
        ("live", &["live"][..], &["现场", "演唱会"][..]),
        (
            "instrumental",
            &["instrumental", "karaoke"][..],
            &["伴奏", "纯音乐"][..],
        ),
        ("cover", &["cover"][..], &["翻唱"][..]),
        ("remix", &["remix", "dj"][..], &["混音"][..]),
        ("fast", &["sped", "speedup"][..], &["加速"][..]),
        ("slow", &["slowed"][..], &["降速", "慢速"][..]),
        ("acoustic", &["acoustic", "unplugged"][..], &["不插电"][..]),
    ] {
        if ascii.iter().any(|word| words.contains(word))
            || chinese.iter().any(|word| qualifiers.contains(word))
        {
            tags.insert(tag);
        }
    }
    tags
}

pub(super) fn instrumental_title(title: &str) -> bool {
    version_tags(title).contains("instrumental")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recording_qualifiers_are_not_song_title_substrings() {
        assert!(version_tags("Live Forever").is_empty());
        assert_ne!(version_tags("Song"), version_tags("Song (Live at Wembley)"));
        assert_ne!(version_tags("歌曲（加速版）"), version_tags("歌曲"));
        assert!(instrumental_title("歌曲 (Instrumental)"));
        assert!(instrumental_title("歌曲（伴奏）"));
        assert!(!instrumental_title("Instrumental Love"));
    }
}
