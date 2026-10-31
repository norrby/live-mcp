// guide.ts – a device author's guide: a Markdown file beside the .amxd file with the same name (Synth.amxd, Synth.md).
// The parameters' help texts say what each control does; the guide says how the instrument behind them works, in
// sections an assistant reads one at a time: a title (#), an introduction, then sections (##).

export interface GuideSection {
  name: string;
  text: string;
}

export interface M4lGuide {
  file: string;
  title?: string;
  /** the text between the title and the first section */
  intro?: string;
  sections: GuideSection[];
}

/** The guide file that belongs to an .amxd file: the same path with .md in place of .amxd. */
export function guideFileFor(amxdFile: string): string {
  return amxdFile.replace(/\.amxd$/i, ".md");
}

/** Splits a guide into title, introduction and sections. Plain text without headings is all introduction. */
export function parseGuide(text: string, file: string): M4lGuide {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const guide: M4lGuide = { file, sections: [] };
  let current: GuideSection | undefined;
  const intro: string[] = [];
  for (const line of lines) {
    const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h1 && !guide.title && !current && intro.every((l) => !l.trim())) {
      guide.title = h1[1];
    } else if (h2) {
      current = { name: h2[1], text: "" };
      guide.sections.push(current);
    } else if (current) {
      current.text += (current.text ? "\n" : "") + line;
    } else {
      intro.push(line);
    }
  }
  for (const s of guide.sections) s.text = s.text.trim();
  const introText = intro.join("\n").trim();
  if (introText) guide.intro = introText;
  return guide;
}

/** The section whose heading is, starts with or contains `wanted` (case-insensitive), in that order of preference. */
export function findSection(guide: M4lGuide, wanted: string): GuideSection[] {
  const w = wanted.trim().toLowerCase();
  if (!w) return [];
  const exact = guide.sections.filter((s) => s.name.toLowerCase() === w);
  if (exact.length) return exact;
  const starts = guide.sections.filter((s) => s.name.toLowerCase().startsWith(w));
  if (starts.length) return starts;
  return guide.sections.filter((s) => s.name.toLowerCase().includes(w));
}
