import { describe, expect, it } from "vitest";
import { conflictedCopyPath, isText, merge3 } from "./merge";

describe("merge3", () => {
    const base = "# Shopping\n\n- milk\n- bread\n- eggs\n";

    it("combines edits to different lines", () => {
        const mine = base.replace("milk", "oat milk");
        const theirs = base.replace("eggs", "eggs\n- butter");
        expect(merge3(base, mine, theirs)).toBe("# Shopping\n\n- oat milk\n- bread\n- eggs\n- butter\n");
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
