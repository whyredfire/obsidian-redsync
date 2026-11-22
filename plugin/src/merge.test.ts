import { describe, expect, it } from "vitest";
import { conflictedCopyPath, isText, merge3 } from "./merge";

describe("merge3", () => {
    const base = "# Shopping\n\n- milk\n- bread\n- eggs\n";

    it("combines edits to different lines", () => {
        const mine = base.replace("milk", "oat milk");
        const theirs = base.replace("eggs", "eggs\n- butter");
        expect(merge3(base, mine, theirs)).toBe("# Shopping\n\n- oat milk\n- bread\n- eggs\n- butter\n");
    });

    it("keeps lines whole when one side appends while the other types a last line", () => {
        expect(merge3("a\nb\n", "a\nb\nmine", "a\nb\ntheirs\n")).toBe("a\nb\nmine\ntheirs\n");
    });

    it("keeps a last line without a line break apart from lines added after it", () => {
        expect(merge3("a\n", "a\nmine\n", "a\ntheirs")).toBe("a\nmine\ntheirs");
        expect(merge3("a\n", "a\nmine", "a\ntheirs\n")).toBe("a\nmine\ntheirs\n");
    });

    it("merges edits to different sentences of one paragraph", () => {
        const base = "The quick brown fox jumps over the lazy dog. It was a sunny day.\n";
        const mine = base.replace("brown", "red");
        const theirs = base.replace("sunny", "rainy");
        expect(merge3(base, mine, theirs)).toBe("The quick red fox jumps over the lazy dog. It was a rainy day.\n");
    });

    it("keeps lines both sides added between the same lines", () => {
        expect(merge3("a\nz\n", "a\nmine\nz\n", "a\ntheirs\nz\n")).toBe("a\nmine\ntheirs\nz\n");
    });

    it("combines edits to neighbouring lines", () => {
        expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n")).toBe("A\nB\nc\n");
    });

    it("places the other side's lines even when this side added lines above them", () => {
        const base = "one\ntwo\nthree\n";
        expect(merge3(base, "zero\n" + base, base + "four\n")).toBe("zero\none\ntwo\nthree\nfour\n");
    });

    it("takes the only side that changed", () => {
        expect(merge3(base, base, "new")).toBe("new");
        expect(merge3(base, "mine", base)).toBe("mine");
    });

    it("gives up when the other side's edit has nowhere to go", () => {
        const theirs = base.replace("bread", "sourdough bread");
        expect(merge3(base, "Completely rewritten.", theirs)).toBeNull();
    });
});

describe("conflictedCopyPath", () => {
    const mtime = new Date(2026, 10, 21, 14, 30).getTime();

    it("names the copy after the note and the time", () => {
        expect(conflictedCopyPath("Folder/Note.md", mtime, () => false)).toBe("Folder/Note (Conflicted copy 202611211430).md");
        expect(conflictedCopyPath("v1.2/README", mtime, () => false)).toBe("v1.2/README (Conflicted copy 202611211430)");
    });

    it("counts up when a copy exists", () => {
        const taken = new Set(["Note (Conflicted copy 202611211430).md"]);
        expect(conflictedCopyPath("Note.md", mtime, (p) => taken.has(p))).toBe("Note (Conflicted copy 202611211430 2).md");
    });
});

it("treats notes and canvases as text, images as binary", () => {
    expect([isText("a.md"), isText("b.CANVAS"), isText("c.png"), isText("noextension")]).toEqual([true, true, false, false]);
});
