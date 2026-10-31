// guide.ts – a device author's guide: a Markdown file the device's description names ("… as device-guide.md"),
// embedded in the frozen .amxd file as one of its dependencies, or beside an unfrozen one.
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

/** The .md file a device's description names, such as "device-guide.md" in "… is embedded in the device as device-guide.md." */
export function guideNameIn(description: string): string | undefined {
  const quoted = /["'`“]([^"'`“”/\\]+\.md)["'`”]/i.exec(description);
  if (quoted) return quoted[1];
  const bare = /(?:^|[\s(])([^\s"'`()/\\]+\.md)(?=[\s).,;:!?]|$)/i.exec(description);
  return bare?.[1];
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
