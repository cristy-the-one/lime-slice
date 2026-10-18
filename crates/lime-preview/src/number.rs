//! `JSON.stringify` of a finite number. Ryū gives the shortest digits; the
//! placement of the point follows ECMA-262 `Number::toString`, which is what
//! `JSON.stringify` uses. A shared fixture pins that against Node.

use ryu::Buffer;

/// The characters `JSON.stringify` would write for `n`, or `None` when `n` is not finite.
pub fn json_number(n: f64) -> Option<String> {
    if !n.is_finite() {
        return None;
    }
    // `JSON.stringify(-0)` is `0`. A negative zero must not reach the preimage.
    if n == 0.0 {
        return Some("0".to_string());
    }
    let mut buffer = Buffer::new();
    Some(ecma_from_ryu(buffer.format(n)))
}

/// Ryū's shortest form, rewritten with the ECMA-262 point and `e+` sign.
fn ecma_from_ryu(raw: &str) -> String {
    let (neg, rest) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw),
    };
    let (mantissa, exp) = match rest.split_once(['e', 'E']) {
        Some((mantissa, exp)) => (mantissa, exp.parse::<i32>().unwrap_or(0)),
        None => (rest, 0),
    };
    let mut digits = String::new();
    let mut before = 0i32;
    let mut seen_dot = false;
    for ch in mantissa.chars() {
        if ch == '.' {
            seen_dot = true;
            continue;
        }
        if ch.is_ascii_digit() {
            digits.push(ch);
            if !seen_dot {
                before += 1;
            }
        }
    }
    if digits.is_empty() {
        return "0".to_string();
    }
    // Trailing zeros do not change the highest place, so `n` stays put.
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    // `n` is the ECMA exponent: value = digits × 10^(n − k).
    let n = before + exp;
    let k = digits.len() as i32;
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if n > 0 && n <= 21 {
        let at = n as usize;
        out.push_str(&digits[..at]);
        out.push('.');
        out.push_str(&digits[at..]);
    } else if n > -6 && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push(digits.as_bytes()[0] as char);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let exp = n - 1;
        if exp >= 0 {
            out.push('+');
        }
        out.push_str(&exp.to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::json_number;

    /// Pinned against `JSON.stringify` in Node.
    #[test]
    fn matches_json_stringify() {
        let cases = [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (0.1, "0.1"),
            (0.2, "0.2"),
            (0.3, "0.3"),
            (0.05, "0.05"),
            (1.1, "1.1"),
            (10.0, "10"),
            (40.0, "40"),
            (1e-7, "1e-7"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.0000000000000002, "1.0000000000000002"),
            (0.30000000000000004, "0.30000000000000004"),
            (1e-10, "1e-10"),
            (123.456, "123.456"),
            (-0.28, "-0.28"),
            (0.000001, "0.000001"),
            (1.2345e-7, "1.2345e-7"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
        ];
        for (value, expect) in cases {
            assert_eq!(json_number(value).as_deref(), Some(expect), "{value}");
        }
        assert_eq!(
            json_number(1.0 / 3.0).as_deref(),
            Some("0.3333333333333333")
        );
        assert_eq!(
            json_number(std::f64::consts::PI).as_deref(),
            Some("3.141592653589793")
        );
        assert!(json_number(f64::NAN).is_none());
        assert!(json_number(f64::INFINITY).is_none());
    }
}
