# Altana FAQ: Video Generation and the video studio

Opening answers about making video in Dominion. Several limits here are per-model, so the honest
answer is usually "it depends which model", and these entries say which.

## Q: What is Video Generation?
It is Dominion's video studio: you describe a shot, pick a model, ratio, resolution and length, and
it generates the clip. There is also a project timeline for assembling them.

## Q: Which video models can I use?
Four: Gemini Omni Flash, Seedance 2.0, Kling 3.0 Turbo and Grok Imagine 1.5. You choose in the
"Default model" dropdown.

## Q: Is video generation free?
No. Every video model is paid, and unlike images there is no free video lane.

## Q: What do I need before I can generate video?
Credits and a payment method with auto top-up enabled. Video is the one area with no free path, so
the account has to be able to pay for it.

## Q: Which video model should I pick?
Seedance 2.0 if you want the widest choice of shapes and the highest resolution, Kling 3.0 Turbo for
straightforward text or image work, Gemini Omni Flash if you want editing and continuation, and
Grok Imagine 1.5 when you are starting from an image.

## Q: What aspect ratios can I use?
It depends on the model. Gemini offers 16:9 and 9:16, Kling adds 1:1, Grok adds 3:2 and 2:3, and
Seedance is the widest with 1:1, 4:3, 3:4 and 21:9 as well.

## Q: What resolutions are available?
Gemini is 720p only, Kling does 720p and 1080p, Grok does 480p, 720p and 1080p, and Seedance goes
from 480p all the way to 4K.

## Q: Can I make a 4K video?
Yes, but only on Seedance 2.0. The other three top out at 1080p or below.

## Q: How long can a clip be?
Between 1 and 15 seconds depending on the model: Gemini 3 to 10, Seedance 4 to 15, Kling 3 to 15 and
Grok 1 to 15. Only whole seconds are accepted.

## Q: Can I set the frame rate?
No. There is no fps control in generation at all. Frame rate only appears as a fixed 30 in the export
presets.

## Q: Can I set a seed for video?
No, there is no seed control anywhere in video generation, so each run is a fresh interpretation.

## Q: Can I make a video from a still image?
Yes, that is image mode, and every model except text-only situations supports it. Grok Imagine is
image-led and does not do text-only at all.

## Q: What are the generation modes?
Text, image, reference, edit and continue, though not every model supports all of them. Gemini Omni
Flash is the only one that covers the whole set.

## Q: Can I continue a video I already made?
Yes, with Gemini Omni Flash using continue mode and the prior video's ID. The other three models do
not offer continuation.

## Q: Can I edit an existing video?
Gemini Omni Flash supports an edit mode against a source video. The others do not.

## Q: How do I give it a reference image or video?
The reference fields take URLs rather than file uploads, so the material needs to be reachable at a
link. There is no file picker on the generation inputs.

## Q: Can it generate sound?
There is a "Generate audio" checkbox, but it only actually reaches the provider on Seedance 2.0. The
other models ignore it, so do not count on audio from them.

## Q: How long does a video take to generate?
It varies by model, length and resolution, and the app deliberately does not print a fake estimate.
You get a live progress percentage from the provider instead.

## Q: How do I know how far along my video is?
The job shows a real progress percentage reported by the provider, moving through queued, then
generating, then ready or failed.

## Q: What do the job states mean?
Queued means waiting to start, generating means it is being made, retrying means a transient error is
being worked around, and then it ends as ready or failed.

## Q: What happens if I close the app while a video is generating?
The job record is durable and the provider keeps working. On mobile a single generation will pick
itself back up, but on desktop a reload will not resume the progress display.

## Q: My desktop video seemed to stall after I refreshed. What happened?
Refreshing the desktop studio mid-generation stops it polling for progress. The video itself is
usually still being made on the provider's side, so check the project again rather than re-running it.

## Q: What does a video cost?
You are charged on what the provider actually charged, converted at one hundred credits to the
dollar. Longer clips at higher resolutions cost more.

## Q: Can I see a cost estimate before I generate?
Not a real one. The screen has a placeholder where an estimate belongs, but no figure is actually
calculated yet, so treat it as not implemented rather than as a quote.

## Q: What is the maximum project size?
A project can hold up to 100 scenes, run up to six hours long, use three video and four audio tracks,
and take up to 2GB.

## Q: How many projects can I have?
Up to 50 per account. You can also create up to 10 new projects a minute, which is a guard against
runaway automation rather than a real workflow limit.

## Q: Is there a rate limit on generating?
Yes, up to 30 generations per minute. It exists to stop a loop running away with your credits.

## Q: What is the Screenwriter?
It is one of the AI roles that helps build the project rather than render the video: it drafts the
script and structure. It is billed separately from the video generation itself.

## Q: What is the Creative Director?
Another supporting AI role, focused on the creative direction of the piece rather than the individual
render. Like the other roles, it bills separately.

## Q: What is the Visual Orchestrator?
It is the role that plans the visual sequence across scenes. It is a planning model, not a video
model, and it is billed as its own turn.

## Q: Do the AI roles cost extra?
Yes. The Screenwriter, Creative Director, Visual Orchestrator and Liaison are separate model calls
with their own cost, on top of what the video generation itself costs.

## Q: What formats can I export?
MP4, MOV and WebM are offered as export formats. Note that the generated clips themselves always come
out as MP4 regardless.

## Q: What are the platform presets?
YouTube, TikTok, Instagram Reels, LinkedIn and a generic option. They are project and export settings
rather than something that changes how the video is generated.

## Q: Does picking TikTok change the video I get?
Not the generation itself. It sets the project and export expectations, so you still want to choose a
tall ratio like 9:16 when you generate.

## Q: What happens if a video generation fails?
It stops with a coded error and tells you which model failed. There is no silent switch to a
different provider, so you always know what produced your result.

## Q: Does it retry a failed video?
Only for genuinely transient problems such as rate limits and timeouts, with a backoff, and only a
few attempts. A real rejection is reported rather than hammered.

## Q: Why can I not generate text-only video on Grok?
Grok Imagine 1.5 is built around starting from an image or a reference. Give it a still to work from,
or pick a different model for text-only.

## Q: How long can a video prompt be?
It varies by model, with Seedance accepting up to 10,000 characters and Kling around 3,000. The
others simply require you to write something meaningful.

## Q: What resolution should I use for social media?
1080p at 9:16 is the safe choice for TikTok, Reels and Shorts. Going to 4K rarely helps for feeds
that recompress everything anyway.

## Q: What is the difference between 720p, 1080p and 4K?
It is the number of pixels: 720p is fine for small embeds, 1080p is the normal standard for most
platforms, and 4K is four times 1080p and mostly matters for large screens or heavy cropping.

## Q: Should I always generate at the highest resolution?
No. Higher resolution costs more and takes longer, and most platforms recompress your upload anyway.
Match the resolution to where it will actually be watched.

## Q: What aspect ratio should I use for YouTube?
16:9 is the standard landscape shape for YouTube. Use 9:16 for Shorts.

## Q: What aspect ratio is right for TikTok and Reels?
9:16, the tall shape. Anything else gets letterboxed or cropped by the platform.

## Q: What is 21:9 good for?
It is the very wide cinematic shape, good for a filmic look or a website hero banner. Only Seedance
offers it.

## Q: Why do my clips have to be so short?
Current video models generate in short spans, up to about 15 seconds. Longer pieces are built by
generating several clips and assembling them on the timeline.

## Q: How do I make a longer video?
Generate several clips and put them together in the project timeline. On Gemini Omni Flash you can
also use continue mode to extend from a previous clip.

## Q: How do I keep a character consistent across clips?
Use a reference image of that character on every generation, and keep the descriptive wording
identical between shots. Consistency comes from the inputs, not from the model remembering.

## Q: Why does my video not match my prompt exactly?
Video models interpret rather than execute. Short, concrete descriptions of subject, action and
camera work far better than long lists of adjectives.

## Q: How should I write a video prompt?
Name the subject, what it is doing, the setting, and the camera movement, in that order. Leave out
anything you do not actually care about.

## Q: Can I upload my own video file to edit?
The generation inputs take URLs rather than uploads, so your source needs to be reachable at a link.
The timeline is where local assembly work happens.

## Q: Is my video kept on your server?
Projects are stored so you can come back to them, within a 2GB per project allowance. The generation
itself happens at the provider.

## Q: Does video work in Trusted privacy mode?
Yes. The studio runs its own fixed crew of providers and says so on its surface, so Trusted mode
does not block it. Only Private mode blocks video.

## Q: Why does video not work in Private privacy mode?
Private mode promises a single provider, Anthropic, and video generation runs on Runware, so it is
refused rather than quietly rerouted. Switch to Normal or Trusted to generate video.

## Q: Why does it say video generation is not configured?
The server has no key for the video render engine yet, so nothing can generate. Planning, chat, the
screenwriter and the storyboard still work, and the banner goes away once the key is added.

## Q: Why is there no free video option like there is for images?
Video generation is dramatically more expensive to run than an image, so there is no free lane that
would be honest to offer. Images have one precisely because they are cheap enough.
