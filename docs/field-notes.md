# Field notes

The bugs and surprises met while building Live MCP, and what was done about them. Most of them were found by an AI
assistant using the server for real music work, which is the point of keeping this log: an MCP server is used by a
reader that takes every word of a tool answer literally and never sees Live's window. What a human would notice at a
glance, the assistant only knows if a tool says it.

Each entry says what happened, why, and what changed. The lessons at the end are what we would tell someone starting
an MCP server of their own.

## How the bugs were found

- **Real sessions.** An assistant made music with the server: tracks, clips, automation, recording a hardware synth.
  The bugs below come from those sessions far more than from tests.
- **Asking the assistant afterwards.** When something went wrong, the session that did it was asked what it called,
  in which order, what the answers said and what it had believed. Its account was usually precise enough to find the
  cause without reproducing anything.
- **Blind tests.** A fresh session, with no history and no hints, was given a task ("read this device's wavetable and
  describe how you would change step 3"). What it could not find out on its own, the server had to say.
- **Reviews.** A second model read the code and the tool answers and listed bugs; each one was checked before it was
  fixed.
- **A fake Live.** The tests run the real SDK classes against an in-memory Live (`test/fake-host.ts`). When Live
  turned out to behave in some particular way, the fake was taught to behave the same, so the test fails the way Live
  did before the fix makes it pass.

## The log

### An installed extension did not start at all

**What happened.** The first release installed fine, showed up under Settings → Extensions, and never answered.

**Why.** With Developer Mode on, Live does not start its own Extension Host; it waits for a developer to run one.

**Fix.** The README and `docs/development.md` say to turn Developer Mode off for an installed extension.

### Installed, the extension may not touch files outside its own folders

**What happened.** Everything that worked in development (reading `.amxd` files, writing a config next to the bridge,
importing audio) failed once installed, with "Access to this API has been restricted", or for audio import with a
rejection whose reason was `undefined`.

**Why.** An installed extension runs under Node's permission model and may only use its storage and temp folders.
The development host has no such limit, so nothing showed up until the first real install. Live's own
`importIntoProject` is bound by the same rule, which is not what its name suggests.

**Fix.** The LiveRemote bridge, a Python script that runs inside Live without those limits, reads `.amxd` files and
audio files on the extension's behalf. Audio is copied into the extension's temp folder in chunks, imported, and the
copy removed.

**Lesson.** Test the installed package early, not only the development build.

### One uncaught error took the whole server down

**What happened.** A `new URL(...)` in the bundle threw `URL is not defined`, and the Extension Host exited.

**Why.** The extension runs in a context with fewer globals than plain Node, and an unhandled rejection in a request
handler ends the process.

**Fix.** Globals the code needs are imported explicitly, and every handler is wrapped so an error becomes a tool error,
never a crash.

### The bridge took 20 seconds to answer

**What happened.** Listing the `.amxd` files through the bridge timed out at start and took over 20 s even later.

**Why.** Live keeps Python's global lock most of the time, so work on a background thread in a Remote Script starves.

**Fix.** The bridge does its work on Live's main thread, in small pieces: 0.6 s instead of 22.

### Device kinds read "Ve" and "Le"

**What happened.** `get_set` called devices "Ve" and "Le" instead of Live's class names.

**Why.** The release build was minified, and the code used class names as data.

**Fix.** The bundler keeps class names.

### The assistant pressed "Push patch" three times without being asked

**What happened.** A Max for Live editor for a hardware synth has a Patch Action parameter: Pull, Push or Store a
patch. An assistant set it to Push three times on its own initiative while designing a sound.

**Why.** When asked, the assistant explained: the device's description called Pull and Push harmless, Patch Action had
no help text, and it believed edits stayed in the editor until pushed. It treated the description as advice and the
parameter list as the rules.

**Fix.** Two layers. The device's author rewrote the texts. And Live MCP got a rule it enforces itself: a parameter
whose Info View text ends with `[ask first]` is refused by `set_parameters` unless the call says the user asked for that
very change. The whole call is refused, so nothing half happens.

**Lesson.** An instruction in text is followed most of the time. A check in the tool is followed every time. For
anything that cannot be taken back, use the check.

### The guard was blind for the first seconds

**What happened.** Right after Live started, `[ask first]` parameters could be changed.

**Why.** The marks come from the `.amxd` files, read through the bridge in the background; until they arrived, no
parameter was marked.

**Fix.** A change waits for the files to be read before it is checked.

### A track that had played a session clip ignored the arrangement

**What happened.** An assistant built an arrangement, pressed play, and heard nothing of it.

**Why.** In Live, once a session clip has played on a track, that track ignores its arrangement clips until Back to
Arrangement is pressed. Only a red button in Live's window shows it.

**Fix.** `transport` has a `back_to_arrangement` action and reports `arrangement_overridden`, and its description
explains when it is needed.

### Routing an External Instrument failed with a Python error

**What happened.** Setting the MIDI output of Live's External Instrument failed with `cannot unpack non-iterable
Device object`.

**Why.** Two bugs on top of each other. The bridge had two methods with the same name, and the later one replaced the
first. Once that was fixed, it turned out that Live exposes no routing for External Instrument through any API.

**Fix.** The duplicate was removed, and the tools now say plainly that only Max for Live devices have routing points;
`get_capabilities` lists it under what cannot be done, so the assistant asks the user instead of trying workarounds.

### Automation curves came back straight

**What happened.** Clip automation written with curves read back with every curve flat.

**Why.** A test against Live showed that it keeps an envelope point's curve only if a later point already exists when
the point is written.

**Fix.** The bridge writes the points last first.

### An unwarped audio clip reported its length in seconds

**What happened.** A 30-second unwarped clip at 120 BPM said `length: 30` where every other clip speaks beats.

**Why.** Live keeps an unwarped clip's markers in seconds.

**Fix.** `length` is converted to beats, and `lengthSeconds` and `warped` are reported beside it.

### Recording landed on the wrong track, or recorded nothing

**What happened.** Four of twelve arrangement recordings came out empty, and earlier takes were overwritten with empty
clips.

**Why.** Live arms the selected MIDI track by itself (the pink arm button), while `arm` reads `false`. When the user
clicked a MIDI track between the assistant selecting its audio track and starting the recording, Live recorded on the
MIDI track, replacing the clip that was meant to play. Two smaller causes: Monitor In on a MIDI track silences its
clips, and play starts at the start marker, wherever the user last clicked, not at the position `transport` had
reported.

**Fix.** We first planned to report more and let `record_on` warn. A review pointed out that a warning still leaves
a gap: record, play and the user's click are separate moments. So `transport` got a `record` action that takes the
tracks to record on. In one step on Live's main thread, the bridge checks that exactly those tracks would record
(arm or implicit arm), puts the start marker at the requested beat, and plays with the record button on. If any other
track would record, nothing starts and the answer names the track and says to ask the user, not to change their
selection. `stop` afterwards answers with the clips the take added and replaced. `get_set` shows Live's implicit arm
next to `arm`.

Two things turned up while testing it in Live. Setting the play position while stopped does not move where play
starts: Live plays from its start marker, a separate value (`Song.start_time`), so that is what the take now sets.
And the first version kept the take's starting state inside the MCP server object, which the HTTP transport makes
anew for every request, so `stop` could never see it. The test had used one server for every call; now it uses a
new one per call, as HTTP does.

**Lesson.** When the tool cannot see everything the user can change, let the caller say what it intends and check
it at the moment of acting, rather than checking first and acting later.

### Deleting two tracks deleted a neighbour

**What happened.** `delete_track` with two track ids answered `deleted: ["Latency", "Reference"]`, but Live deleted
Latency and the track after Reference.

**Why.** To make several deletes one undo step, they are sent to Live together, and Live finds each object's position
when the delete is sent. The first delete then shifted the second track up one place, and the second delete removed
whatever was now at its old position. Ids did not help: Live resolves them to positions too. The answer was built from
the names read beforehand, so it said what was meant, not what happened.

**Fix.** Deletes sent together go last first, so none of them moves another; the same for devices in one chain and
arrangement clips on one track. The fake Live now resolves positions the same way, and a test deletes non-adjacent
tracks, devices and clips.

**Lesson.** "One undo step" and "one at a time" pull in different directions; find out what the host does between
the two.

## And when it works

Not every surprise was a bug. Asked for a bass whose low-pass filter opens with how hard each note is played, an
assistant found that the hardware synth behind a Max for Live editor has no velocity-to-cutoff routing. It did not
stop there, and it did not reach around Live MCP either: it set an LFO to a flat shape, so that it gives a steady
value rather than a wave, let velocity set that value, and routed the LFO to the filter cutoff. Velocity then moved
the cutoff after all.

It could do that because the tools had given it a true picture: every parameter with its range, choices and the
device author's help text, and plain answers about what Live MCP itself cannot do. The limits it worked around were
the instrument's, which is the musician's job, and the assistant did it well.

## Lessons

- **The assistant only knows what the answers say.** Anything Live shows only in its window (a pink arm button, a red
  Back to Arrangement button, a unit) has to be in a tool answer, or the assistant works from a wrong picture.
- **Put guardrails in the tools, not in instructions.** Instructions help; checks hold. Refuse the whole call when one
  part is wrong, so nothing half happens.
- **Answer with what happened, not with what was asked.** An answer built from the request hides exactly the bugs that
  matter.
- **Ask the assistant what went wrong.** It remembers its calls and its reasoning, and the reasoning shows which text
  misled it.
- **Say what cannot be done.** When an API does not allow something, a clear "no, ask the user" beats a workaround the
  assistant invents.
- **Make the fake behave like the real thing.** When the host surprises you, teach the fake the surprise before fixing
  the code.
