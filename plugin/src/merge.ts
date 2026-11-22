import DiffMatchPatch from "diff-match-patch";

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "canvas", "base", "json", "css", "csv", "svg"]);

export function isText(path: string): boolean {
    return TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase());
}

/** Applies the changes from `base` to `theirs` onto `mine`; null when they cannot all be applied. */
export function merge3(base: string, mine: string, theirs: string): string | null {
    if (mine === theirs || base === theirs) return mine;
    if (base === mine) return theirs;
    const dmp = new DiffMatchPatch();
    const [merged, applied] = dmp.patch_apply(dmp.patch_make(base, theirs), mine);
    return applied.every(Boolean) ? merged : null;
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
