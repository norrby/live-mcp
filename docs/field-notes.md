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

### A review of all the code at once

**What happened.** Earlier reviews had each read the changes since the one before. Once the server had grown and
was in daily use, three reviewers read all of it at once, one for the server, one for the bridge and one for the
tests and file parsers. Each finding was checked in the code before anything was changed. They found about thirty
issues; the ones that mattered:

- The `[ask first]` guard let changes through when the bridge answered but a read of the device files had failed
  half way, the same blindness as in the first seconds after start, in another form. Changes to a device the server
  cannot yet recognise now wait while the bridge answers.
- A request that timed out still ran later on Live's main thread, unseen: a retried undo could undo twice. A request
  Live has not begun when the wait runs out is now dropped.
- The same device given twice, by position and by id, deleted its neighbour; the same parameter given twice was set
  twice with a random winner. Both are now compared by the object, not the address.
- `set_track` made one undo step per field and could rename a track before failing to arm it. `set_routing` could
  change the input and then fail on the output. Both now check first and change in one step, or put things back.
- A MIDI file with notes never released lost every other one; one with a chunk of its own before the tracks lost its
  last track; one with very many notes overflowed the stack.
- Smaller ones: `live://set` sent an unfinished promise as `{}`, `get_changes` mixed snapshots of different scopes,
  a range shorter than 0.4 s was reported as silent, and "2 kHz" was read as 2 Hz.

**Lesson.** Reviews of changes miss what lives between them. Every part of the half-done and identity bugs looked
right on its own.

### The filter that could not be heard

**What happened.** Asked for a bass whose filter opens with velocity on a hardware synth behind a Max for Live
editor, an assistant set every parameter right; `get_parameters` and a hardware measurement agreed. The sound did not
change. Blame went to the help texts, to the LFO shape and to the assistant's reading of them, all wrongly.

**Why.** One parameter, which routes an oscillator through the filter, already stood at the value the assistant set.
Live sends nothing to a device for a value equal to the one it shows, so the editor never sent it on, and the synth's
working memory kept an older sound in which that oscillator bypassed the filter. Nudging the value away and back made
the filter audible at once.

**Fix.** None in Live MCP. For Live's own devices the parameter value is the state, so nothing can drift. The gap is
between an editor and the hardware it drives, and the place to say so is the editor's own description, which the
assistant reads first: ask the user to push the patch before shaping a sound.

**Lesson.** A parameter's value is the truth only when the device is where the sound is made.

### A small model, a large device and a word that was only in the help texts

**What happened.** The server was tried with a small, cheap model to see what it would stumble on. It managed every
task, including the hardware editor, but two things cost it: a device with more than two hundred parameters answered
`list_parameters` with 40 kB, and a search for "velocity" found nothing, because Live's parameter names are short
("Vel") and the word stood only in the author's help texts.

**Fix.** A device with more than 64 parameters answers with compact rows unless asked otherwise, `find_parameters`
and `query` search the help texts too, and the descriptions say that Live's names are short.

**Lesson.** A capable model papers over a bad answer; a small one shows where the answer is bad. Test with the
smallest model you expect to be used.

### The bridge said the device was loaded; the device was not ready

**What happened.** `insert_device` loaded a large Max for Live device and the parameters set right after it were
ignored. A second large device took ten seconds to appear at all after the bridge had answered that it was loaded.

**Why.** Max for Live devices start their patch after Live has created the device, and this editor ignores the first
value it receives per parameter after loading. Nothing in Live says when a patch is done.

**Fix.** A convention for device authors: a parameter whose help text ends with `[ready]` starts at 0 and is set to
its maximum by the patch when it is ready; `insert_device` waits for it, or for a settle time (`settleMs`) otherwise,
and waits up to ten seconds for the device to appear in the first place. The convention is documented for other
authors. It is not free: the write to the flag is an undo step, and the editor that first carried it dropped it again
the same evening, once that cost showed (see the next note but one); it now relies on the settle time.

**Lesson.** "Created" and "ready" are different moments for anything that runs its own program.

### Recordings landed in the arrangement; the user lives in the Session View

**What happened.** The checked arrangement recording above worked, and confused the user every time: the takes
appeared in a view they never open, with the arrangement overridden by the session clips they do use. The assistant
had chosen the arrangement because it gave a start on a known beat and because `measure_audio` could only read the
arrangement.

**Fix.** `record_clip` records into one empty session slot of an armed track: the bridge checks on Live's main thread
that the track is armed (or is the selected MIDI track Live arms by itself), that the slot is empty and that no
arrangement recording is running, then fires the slot with a record length (`ClipSlot.fire(record_length)`), four
bars unless asked. Live stops the recording itself and the clip plays on; a stop afterwards answers with the clip.

Two things turned up in Live. The recorded clip loops from then on, as any session clip does, so a test that is not
stopped keeps sounding. And a stop before the launch quantization answered with the clip's length as it stood at
that moment, 4 beats with a loop end of 63,072,000, which is Live's placeholder while a recording runs; the final clip
was 16 beats. The report now says `stillRecording` until Live has ended the recording.

**Lesson.** Build for the view the user works in, and read the result after the host has finished, not when the
command returns.

### Only the arrangement could be measured

**What happened.** With recordings in the session, `measure_audio` had nothing to measure: the Extensions API renders
a range of a track's arrangement, and nothing else.

**Fix.** A session or arrangement audio clip can be measured from its own file, cut at its markers: seconds for an
unwarped clip, beats mapped through the warp markers for a warped one. The same change added peak and RMS per window,
onsets after silence and the dominant frequency of each window, which a bass line recorded through the new
`record_clip` showed as its eight notes with their fundamentals.

One more thing came with it: after the server had gained arguments, the running clients kept sending the old ones.
An MCP client reads the tool list once, when it connects, and a stateless server has no stream on which to announce
a change (`listChanged: false`). Until the client reconnects it fills in a form that no longer exists.

**Lesson.** When the host's API draws a line, measure what is on the other side of it from the file.

### Restarting the host while Live loaded a device crashed Live

**What happened.** A development loop that rebuilt and restarted the extension host on every saved file restarted it
while Live was loading a Max for Live device through the bridge. Live crashed.

**Why.** The bridge's request was still running on Live's main thread when the process it was answering went away.

**Fix.** Before a restart, the loop pings the bridge and waits while it is busy. The rule for a human is the same:
never rebuild while a device is loading.

**Lesson.** A host that runs your code inside itself is not isolated from your restarts.

### Undo did not remove the device it had just loaded

**What happened.** An assistant loaded a Max for Live editor with `load_browser_item`, changed its mind and called
`undo`. The device stayed. Three undos later it still stayed. A built-in Max device loaded the same way was gone after
one undo. On a test track, nineteen undos left the editor in place and changed nothing visible in the set; only the
device's own ready flag had gone back to "loading" on the first.

**Why.** Live's Edit menu gave the answer: the next step read *Undo Change "Osc 3 Table Note"*. A freshly loaded
editor has an empty table, but when it loaded it still wrote the default step value into the knob that mirrors the
table, so that the knob would show the table. Live made an undo step of that write, although the knob is marked as
not undoable. Undo then turned the knob back to zero; the editor took that for a turn of the knob by the user, refused
it, since there is no step under the knob, and wrote the default again, which became a new undo step. Each undo
produced the step that the next undo would take back, and the loading of the device never came up.

**Fix.** On the device's side: the knobs are not written when there is no step under them, a knob is never written
before Live has restored it, and the bank switching starts from the bank the device is built with. A freshly loaded
editor then went away after three undos: its ready flag, its hidden version number, and the load itself. The author
went further and took away the first two writes as well, the ready flag among them, since two undos to remove a device
confuse a user: a new editor now goes with one undo, and `load_browser_item` waits its settle time instead. Live MCP
cannot tell, when `undo` is asked for, how many steps a device added; the `undo` tool is still one step, as Live's
own Cmd+Z is.

**Lesson.** Everything a Max for Live device writes to its parameters becomes an undo step for the user, whatever the
object's undo setting says, and a device that answers an undone value by writing it again has made undo impossible.
A device that is quiet at load, and takes what Live gives it, is also one that undo removes in a few steps.

## And when it works

Not every surprise was a bug. Asked for a bass whose low-pass filter opens with how hard each note is played, an
assistant found that the hardware synth behind a Max for Live editor has no velocity-to-cutoff routing. It did not
stop there, and it did not reach around Live MCP either: it set an LFO to a flat shape, so that it gives a steady
value rather than a wave, let velocity set that value, and routed the LFO to the filter cutoff. Velocity then moved
the cutoff after all.

It could do that because the tools had given it a true picture: every parameter with its range, choices and the
device author's help text, and plain answers about what Live MCP itself cannot do. The limits it worked around were
the instrument's, which is the musician's job, and the assistant did it well.

Later the same evening, the two newest tools met for the first time: an assistant recorded a bass line into a session
slot with `record_clip` and read it back with `measure_audio` on the clip. The answer had an onset every half second
and the fundamentals of the notes to a tenth of a hertz, which is the first time the assistant could say what a
hardware synth had actually played rather than what it had been told to play.

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
