//! Pembantu SQL (port dari src/sql.js): rewrite fungsi non-deterministik & klasifikasi read/write.

/// Panjang token ber-kutip yang dimulai di `s[i..]` (string, identifier, komentar, dollar-quote), atau None.
fn quoted_len(s: &str, i: usize) -> Option<usize> {
    let b = s.as_bytes();
    match b[i] {
        b'\'' | b'"' => {
            let q = b[i]; let mut j = i + 1;
            while j < b.len() {
                if b[j] == q { if j + 1 < b.len() && b[j + 1] == q { j += 2; continue; } return Some(j + 1 - i); }
                j += 1;
            }
            None
        }
        b'-' if b.get(i + 1) == Some(&b'-') => Some(s[i..].find('\n').unwrap_or(s.len() - i)),
        b'/' if b.get(i + 1) == Some(&b'*') => s[i + 2..].find("*/").map(|e| e + 4),
        b'$' => {
            let mut j = i + 1;
            if j < b.len() && (b[j].is_ascii_alphabetic() || b[j] == b'_') { while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') { j += 1; } }
            if j < b.len() && b[j] == b'$' {
                let tag = &s[i..=j];
                s[j + 1..].find(tag).map(|e| j + 1 + e + tag.len() - i)
            } else { None }
        }
        _ => None,
    }
}

/// Pecah menjadi (ber_kutip, potongan).
fn tokens(s: &str) -> Vec<(bool, &str)> {
    let mut out = vec![]; let (mut last, mut i) = (0, 0);
    while i < s.len() {
        if !s.is_char_boundary(i) { i += 1; continue; }
        if let Some(n) = quoted_len(s, i) {
            if i > last { out.push((false, &s[last..i])); }
            out.push((true, &s[i..i + n])); i += n; last = i;
        } else { i += 1; }
    }
    if last < s.len() { out.push((false, &s[last..])); }
    out
}

fn is_word(c: u8) -> bool { c.is_ascii_alphanumeric() || c == b'_' }

/// Cari `name` (tanpa beda huruf) sebagai kata utuh di `s`; panggil `f(start,end)`.
fn find_word(s: &str, name: &str) -> Vec<(usize, usize)> {
    let (ls, ln) = (s.to_ascii_lowercase(), name.to_ascii_lowercase());
    let b = ls.as_bytes(); let mut res = vec![]; let mut from = 0;
    while let Some(p) = ls[from..].find(&ln) {
        let st = from + p; let en = st + ln.len();
        if (st == 0 || !is_word(b[st - 1])) && (en >= b.len() || !is_word(b[en])) { res.push((st, en)); from = en; } else { from = st + 1; }
    }
    res
}

fn after_call_parens(s: &str, end: usize) -> Option<usize> {
    let t = &s[end..]; let t2 = t.trim_start();
    if !t2.starts_with('(') { return None; }
    let t3 = t2[1..].trim_start();
    if !t3.starts_with(')') { return None; }
    Some(s.len() - t3.len() + 1)
}

fn sub(s: &str) -> String {
    let mut spans: Vec<(usize, usize, &str)> = vec![];
    for (name, rep) in [("gen_random_uuid", "tg_uuid()"), ("now", "tg_now()"), ("clock_timestamp", "tg_now()"),
                        ("statement_timestamp", "tg_now()"), ("transaction_timestamp", "tg_now()"), ("random", "tg_random()")] {
        for (st, en) in find_word(s, name) { if let Some(e2) = after_call_parens(s, en) { spans.push((st, e2, rep)); } }
    }
    for (st, en) in find_word(s, "current_timestamp") {
        if !s[en..].trim_start().starts_with('(') { spans.push((st, en, "tg_now()")); }
    }
    spans.sort_by_key(|x| x.0);
    let mut out = String::new(); let mut at = 0;
    for (st, en, rep) in spans { if st < at { continue; } out.push_str(&s[at..st]); out.push_str(rep); at = en; }
    out.push_str(&s[at..]); out
}

/// Ganti fungsi non-deterministik dengan tg_*() (string, identifier, komentar, dollar-quote tidak disentuh).
pub fn rewrite(sql: &str) -> String {
    tokens(sql).into_iter().map(|(q, t)| if q { t.to_string() } else { sub(t) }).collect()
}

/// true bila statement tunggal yang hanya membaca.
pub fn is_read(sql: &str) -> bool {
    let s: String = tokens(sql).into_iter().map(|(q, t)| if q { "''" } else { t }).collect();
    let s = s.trim(); let l = s.to_ascii_lowercase();
    if let Some(p) = s.find(';') { if !s[p + 1..].trim().is_empty() { return false; } }
    let first = l.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).next().unwrap_or("");
    if first == "select" { return find_word(&l, "into").is_empty(); }   // SELECT ... INTO membuat tabel
    if matches!(first, "show" | "values" | "explain") { return true; }
    first == "with" && !["insert", "update", "delete", "merge", "into"].iter().any(|w| !find_word(&l, w).is_empty())
}

/// Ganti `$n` (di luar string/komentar/dollar-quote) dengan literal `lits[n-1]`.
pub fn inline_params(sql: &str, lits: &[String]) -> String {
    let mut out = String::new();
    for (q, t) in tokens(sql) {
        if q { out.push_str(t); continue; }
        let b = t.as_bytes(); let mut i = 0;
        while i < b.len() {
            if b[i] == b'$' && i + 1 < b.len() && b[i + 1].is_ascii_digit() && (i == 0 || !is_word(b[i - 1])) {
                let mut j = i + 1; while j < b.len() && b[j].is_ascii_digit() { j += 1; }
                let n: usize = t[i + 1..j].parse().unwrap_or(0);
                if n >= 1 && n <= lits.len() { out.push_str(&lits[n - 1]); i = j; continue; }
            }
            let ch = t[i..].chars().next().unwrap(); out.push(ch); i += ch.len_utf8();
        }
    }
    out
}

/// Pecah skrip menjadi statement di titik koma tingkat atas (string/komentar/dollar-quote dihormati). Statement kosong dibuang.
pub fn split_statements(sql: &str) -> Vec<String> {
    let (mut out, mut cur) = (vec![], String::new());
    for (q, t) in tokens(sql) {
        if q { cur.push_str(t); continue; }
        let mut parts = t.split(';').peekable();
        while let Some(p) = parts.next() {
            cur.push_str(p);
            if parts.peek().is_some() { if !cur.trim().is_empty() { out.push(cur.trim().to_string()); } cur.clear(); }
        }
    }
    if !cur.trim().is_empty() { out.push(cur.trim().to_string()); }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn inline_dan_split() {
        use super::*;
        let l = vec!["('5'::int4)".to_string(), "('x'::text)".to_string()];
        assert_eq!(inline_params("select $1, '$2', $2::text, $3 -- $1\n, $10", &l), "select ('5'::int4), '$2', ('x'::text)::text, $3 -- $1\n, $10");
        assert_eq!(split_statements("select 1; insert into t values ('a;b'); ;select $$;$$"), vec!["select 1", "insert into t values ('a;b')", "select $$;$$"]);
        assert_eq!(split_statements("select 1"), vec!["select 1"]);
    }

    use super::*;
    #[test]
    fn rewrite_cases() {
        let out = rewrite("insert into t values (now(), gen_random_uuid(), 'now()', \"now()\") -- now()\n, random(), current_timestamp");
        assert!(out.starts_with("insert into t values (tg_now(), tg_uuid(), 'now()', \"now()\") -- now()\n, tg_random(), tg_now()"), "{out}");
        assert_eq!(rewrite("select $f$ now() $f$, now ( )"), "select $f$ now() $f$, tg_now()");
        assert_eq!(rewrite("select current_timestamp(3), my_now()"), "select current_timestamp(3), my_now()");
        assert_eq!(rewrite("select 'unterminated now()"), "select 'unterminated tg_now()");
        assert_eq!(rewrite("select /* now() */ 1 -- random()"), "select /* now() */ 1 -- random()");
        assert_eq!(rewrite("select 'é' || now()"), "select 'é' || tg_now()");
    }
    #[test]
    fn read_cases() {
        assert!(is_read("select 1")); assert!(is_read(" SELECT 'a;b' ")); assert!(is_read("select 1;"));
        assert!(!is_read("select 1; drop table x")); assert!(!is_read("insert into t values (1)"));
        assert!(is_read("with a as (select 1) select * from a"));
        assert!(!is_read("with a as (insert into t values(1) returning *) select * from a"));
        assert!(!is_read("select * into t2 from t"));
    }
}
