// address.ts – human-readable addresses for objects in the set, used in every tool argument and result.
//   t0            track 0            r1          return track 1      main        the main track
//   t0/d2         device 2 on t0     t0/d2/c1    chain 1 of a rack   t0/d2/c1/d0 device in that chain
//   t0/d2/p17     parameter 17       t0/vol      track volume        t0/pan  t0/send0   mixer parameters
//   t0/s3         session clip slot 3 (and the clip in it)             t0/a0       arrangement clip 0 of t0
//   #123          any object by its Live handle id (stable while the object exists)
import { LiveError } from "./errors.js";

export type Segment =
  | { kind: "track"; index: number }
  | { kind: "return"; index: number }
  | { kind: "main" }
  | { kind: "handle"; id: bigint }
  | { kind: "device"; index: number }
  | { kind: "chain"; index: number }
  | { kind: "param"; index: number }
  | { kind: "slot"; index: number }
  | { kind: "arrangement"; index: number }
  | { kind: "mixer"; which: "vol" | "pan" | "send"; index: number };

export function parseAddress(text: string): Segment[] {
  const parts = text.trim().split("/").filter((p) => p.length);
  if (!parts.length) throw new LiveError("empty address");
  return parts.map((part, i) => {
    let m: RegExpMatchArray | null;
    if (i === 0) {
      if ((m = part.match(/^#(\d+)$/))) return { kind: "handle", id: BigInt(m[1]) } as Segment;
      if ((m = part.match(/^t(\d+)$/))) return { kind: "track", index: Number(m[1]) } as Segment;
      if ((m = part.match(/^r(\d+)$/))) return { kind: "return", index: Number(m[1]) } as Segment;
      if (part === "main" || part === "master") return { kind: "main" } as Segment;
    } else {
      if ((m = part.match(/^d(\d+)$/))) return { kind: "device", index: Number(m[1]) } as Segment;
      if ((m = part.match(/^c(\d+)$/))) return { kind: "chain", index: Number(m[1]) } as Segment;
      if ((m = part.match(/^p(\d+)$/))) return { kind: "param", index: Number(m[1]) } as Segment;
      if ((m = part.match(/^s(\d+)$/))) return { kind: "slot", index: Number(m[1]) } as Segment;
      if ((m = part.match(/^a(\d+)$/))) return { kind: "arrangement", index: Number(m[1]) } as Segment;
      if (part === "vol" || part === "volume") return { kind: "mixer", which: "vol", index: 0 } as Segment;
      if (part === "pan" || part === "panning") return { kind: "mixer", which: "pan", index: 0 } as Segment;
      if ((m = part.match(/^send(\d+)$/))) return { kind: "mixer", which: "send", index: Number(m[1]) } as Segment;
    }
    throw new LiveError(`bad address segment "${part}" in "${text}"`);
  });
}
