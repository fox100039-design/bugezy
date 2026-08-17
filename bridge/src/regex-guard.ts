// PM-375：使用者自訂 regex 的複雜度守衛。
//
// `add_severity_rule` 與記憶層 L6／L4 的 `regex:` 規則都吃使用者給的 pattern，
// 而那個 pattern 之後會對**每一筆錯誤**執行。一條 `(a+)+$` 就足以讓每次查詢
// 卡在指數級回溯上——不需要惡意，寫錯也會。

/** 卡片指定：pattern 限長 200 字元。 */
export const MAX_PATTERN_LEN = 200;

/**
 * 明顯的巢狀量詞：`(x+)+` / `(x*)*` / `(x+)*` / `(x*)+` / `(x{n,})+` …
 *
 * ⚠ 這是**保守的樣式比對，不是完備的 ReDoS 偵測**（那在一般情況下不可判定）。
 * 它擋掉的是最常見、最容易寫出來的那一類；真正的兜底是 PM-373 的輸入限長
 * ——兩者一起才有意義，只靠其中一個都不夠。
 */
const NESTED_QUANTIFIER = /\([^)]*[+*}]\s*\)\s*[+*]|\([^)]*[+*]\)[{]/;

/** 兩個相鄰的無界量詞，例如 `.*.*`、`\s+\s+` —— 同樣是典型的回溯放大器。 */
const ADJACENT_UNBOUNDED = /(\.\*|\.\+){2,}/;

export interface CompileResult {
  ok: boolean;
  re: RegExp | null;
  error?: string;
}

/**
 * 檢查並**預先編譯** pattern。
 *
 * 預編譯是重點之一：原本每次分類都 `new RegExp(...)`，等於把編譯成本乘上錯誤筆數。
 * 在 add 的時候編一次、之後重複用同一個物件即可。
 */
export function safeCompile(pattern: string, flags = ''): CompileResult {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, re: null, error: 'pattern 不可為空。' };
  }
  if (pattern.length > MAX_PATTERN_LEN) {
    return {
      ok: false,
      re: null,
      error: `pattern 長度 ${pattern.length} 超過上限 ${MAX_PATTERN_LEN} 字元。過長的樣式通常代表應該拆成多條規則。`,
    };
  }
  if (NESTED_QUANTIFIER.test(pattern) || ADJACENT_UNBOUNDED.test(pattern)) {
    return {
      ok: false,
      re: null,
      error:
        `pattern 含有巢狀／相鄰的無界量詞（例如 (a+)+、(a*)*、.*.*），這類樣式在特定輸入下會發生指數級回溯，` +
        `讓每一次錯誤查詢都卡住。請改寫成不含巢狀量詞的形式，例如把 (a+)+ 改成 a+。`,
    };
  }
  try {
    return { ok: true, re: new RegExp(pattern, flags) };
  } catch (e) {
    return { ok: false, re: null, error: `不是合法的正規表示式：${e instanceof Error ? e.message : String(e)}` };
  }
}
