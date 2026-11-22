import DiffMatchPatch from "diff-match-patch";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "canvas", "base", "json", "css", "csv", "svg"]);

export function isText(path: string): boolean {
    return TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}

/**
 * Applies the changes from `base` to `theirs` onto `mine`; null when they cannot all be applied.
 * Whole lines first, so the other side's lines land between this side's lines and never inside one;
 * then, when both changed the same line (a paragraph is one line in Markdown), character by character.
 */
export function merge3(base: string, mine: string, theirs: string): string | null {
    if (mine === theirs || base === theirs) return mine;
    if (base === mine) return theirs;
    return mergeLines(base, mine, theirs) ?? mergeCharacters(base, mine, theirs);
}

function mergeCharacters(base: string, mine: string, theirs: string): string | null {
    const dmp = new DiffMatchPatch();
    const [merged, applied] = dmp.patch_apply(dmp.patch_make(base, theirs), mine);
    return applied.every(Boolean) ? merged : null;
}

/** A change to the base: lines [start, end) replaced by `lines` (an insertion when start === end). */
interface Hunk {
    start: number;
    end: number;
    lines: string[];
}

function splitLines(text: string): string[] {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The changes from `base` to `other`, line by line. */
function hunks(base: string[], other: string[]): Hunk[] {
    const dmp = new DiffMatchPatch();
    const codes = new Map<string, string>();
    const encode = (lines: string[]) =>
        lines
            .map((line) => {
                let code = codes.get(line);
                if (code === undefined) {
                    code = String.fromCodePoint(0x100 + codes.size);
                    codes.set(line, code);
                }
                return code;
            })
            .join("");
    const diffs = dmp.diff_main(encode(base), encode(other), false);
    const result: Hunk[] = [];
    let position = 0;
    let read = 0;
    for (const [operation, text] of diffs) {
        const count = Array.from(text).length;
        if (operation === DiffMatchPatch.DIFF_EQUAL) {
            position += count;
            read += count;
            continue;
        }
        const last = result.at(-1);
        const hunk = last && last.end === position ? last : { start: position, end: position, lines: [] as string[] };
        if (hunk !== last) result.push(hunk);
        if (operation === DiffMatchPatch.DIFF_DELETE) {
            position += count;
            hunk.end = position;
        } else {
            hunk.lines.push(...other.slice(read, read + count));
            read += count;
        }
    }
    return result;
}

/**
 * Three-way merge on whole lines: changes to different lines combine, lines both sides added at the same place
 * are all kept (this side's first); null when both changed the same lines.
 */
function mergeLines(base: string, mine: string, theirs: string): string | null {
    const baseLines = splitLines(base);
    const changes = [...hunks(baseLines, splitLines(mine)).map((h) => ({ ...h, mine: true })), ...hunks(baseLines, splitLines(theirs)).map((h) => ({ ...h, mine: false }))];
    changes.sort((a, b) => a.start - b.start || a.end - b.end || Number(b.mine) - Number(a.mine));
    for (let i = 1; i < changes.length; i++) {
        const [a, b] = [changes[i - 1], changes[i]];
        const same = a.start === b.start && a.end === b.end && a.lines.join("") === b.lines.join("");
        const bothInsert = a.start === a.end && b.start === b.end;
        if (!same && !bothInsert && b.start < a.end) return null;
    }
    const out: string[] = [];
    let at = 0;
    let previous: Hunk | undefined;
    for (const change of changes) {
        if (previous && change.start === previous.start && change.end === previous.end && change.lines.join("") === previous.lines.join("")) continue;
        out.push(...baseLines.slice(at, change.start));
        out.push(...change.lines);
        at = Math.max(at, change.end);
        previous = change;
    }
    out.push(...baseLines.slice(at));
    // A last line without a line break may no longer be last: keep it a line of its own.
    return out.map((line, i) => (i < out.length - 1 && !line.endsWith("\n") ? `${line}\n` : line)).join("");
}

/** "Folder/Note (Conflicted copy 202611211430).md", or "… 202611211430 2).md" when that exists. */
export function conflictedCopyPath(path: string, mtime: number, exists: (path: string) => boolean): string {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const [stem, extension] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
    const d = new Date(mtime);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
    for (let attempt = 1; ; attempt++) {
        const candidate = `${stem} (Conflicted copy ${stamp}${attempt > 1 ? ` ${attempt}` : ""})${extension}`;
        if (!exists(candidate)) return candidate;
    }
}

export const toText = (data: ArrayBuffer) => new TextDecoder().decode(data);
export const toData = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
