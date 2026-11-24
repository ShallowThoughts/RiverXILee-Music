use std::collections::BTreeSet;

fn artist_key(value: &str) -> String {
    value.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn artist_aliases(value: &str) -> BTreeSet<String> {
    let mut aliases = BTreeSet::from([artist_key(value)]);
    let mut base = String::new();
    let mut alias = String::new();
    let mut depth = 0;
    for c in value.chars() {
        if matches!(c, '(' | '（') { depth += 1; }
        else if matches!(c, ')' | '）') {
            depth = (depth - 1).max(0);
            if depth == 0 { aliases.insert(artist_key(&alias)); alias.clear(); }
        } else if depth == 0 { base.push(c); }
        else { alias.push(c); }
    }
    aliases.insert(artist_key(&base));
    aliases.remove("");
    aliases
}

pub(super) fn artists_match(wanted: &str, names: &[&str]) -> bool {
    if wanted.trim().is_empty() { return true; }
    let aliases: Vec<_> = names.iter().map(|name| artist_aliases(name)).collect();
    let full = artist_key(wanted);
    if aliases.iter().any(|names| names.contains(&full)) { return true; }
    // Compare complete singer tokens, not arbitrary substrings such as 安 / 安然.
    let wanted: Vec<_> = wanted.split(['/', '&', ',', '，', '、', ';', '；'])
        .map(str::trim).filter(|name| !name.is_empty()).map(artist_aliases).collect();
    !wanted.is_empty() && wanted.iter().all(|name| aliases.iter().any(|aliases| !aliases.is_disjoint(name)))
}

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

    #[test]
    fn artist_matching_accepts_aliases_and_reordered_collaborators_not_prefixes() {
        assert!(artists_match("aespa", &["aespa (에스파)"]));
        assert!(artists_match("에스파", &["aespa (에스파)"]));
        assert!(artists_match("Bruno Mars / ROSÉ", &["ROSÉ", "Bruno Mars"]));
        assert!(artists_match("AC/DC", &["AC/DC"]));
        assert!(!artists_match("安", &["安然"]));
        assert!(!artists_match("ROSÉ / Someone Else", &["ROSÉ", "Bruno Mars"]));
        assert!(!artists_match("Alkam / Ami (아미)", &["Ami (아미)"]));
    }
}
