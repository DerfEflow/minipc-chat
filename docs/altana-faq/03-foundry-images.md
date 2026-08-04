# Altana FAQ: The Foundry, image generation

Opening answers about making pictures in Dominion. Note the standing brand rule: the Foundry shows
its engine as "DOMINION AI" and never names the underlying vendor model, so these answers describe
what the engine does and not who makes it.

## Q: What is The Foundry?
The Foundry is Dominion's image generator. You describe a picture, choose a quality and a shape, and
it makes it.

## Q: How do I make an image?
Open The Foundry, type what you want in "WHAT TO MAKE", pick a quality and shape, and send it. The
result lands in your gallery on the same screen.

## Q: How long can my image description be?
Up to 4,000 characters in the box, and the counter under it shows how much you have used. That is far
more room than most prompts need.

## Q: What engine makes the images?
The status cell reads "ENGINE · DOMINION AI". Dominion deliberately does not put the vendor's model
name in front of you, the same way it does not show you its own internals.

## Q: What are the quality settings?
Three: LOW for a rapid concept, MEDIUM for production work, and HIGH for maximum detail. Higher
quality costs more and takes longer.

## Q: Which quality should I use?
Use LOW while you are still deciding what you want, then re-run the one you like at MEDIUM or HIGH.
Iterating cheap and finishing expensive is much better value than starting at HIGH.

## Q: What shapes can I make?
Three: SQUARE at 1:1, PORTRAIT at 2:3, and LANDSCAPE at 3:2. In pixels those are 1024 by 1024, 1024
by 1536, and 1536 by 1024.

## Q: What resolution are the images?
The long edge is 1536 pixels and the short edge 1024, or 1024 square. They come out as raw PNG.

## Q: Are the images watermarked?
No. There is no watermarking anywhere in the image path, so what you get is the plain picture.

## Q: Is there a free way to make images?
Yes. The "FREE DRAFT ENGINE · $0" toggle routes your request to a free lane that costs nothing at
all, with the same description, quality and shape controls.

## Q: Is the free draft engine any good?
It is genuinely useful for concepting and iteration. The paid engine is stronger on fine detail and
on following complicated instructions exactly.

## Q: Why is the free draft toggle greyed out?
That lane needs its provider key configured on the server. When it is missing the toggle disables
itself and says it is not configured yet rather than failing when you press it.

## Q: What does quality mean on the free lane?
It maps to how many refinement steps the image gets: roughly 20 for low, 30 for medium and 40 for
high. More steps means more detail and more time.

## Q: What is the Refine button?
Refine rewrites your description into a stronger prompt before generating. It uses a language model,
so it is a small separate charge.

## Q: Can I use my own pictures as a reference?
Yes. "ADD YOUR OWN IMAGES" takes up to 10 pictures and copies the look of what you add. JPEG, PNG and
WebP are accepted.

## Q: How big can a reference image be?
Up to 6MB each, and they are scaled down to 1024 pixels in your browser before being sent, so a huge
file is not a problem.

## Q: Why can I not add reference images right now?
Reference images do not work with the free draft engine or with batch mode. Turn both off and the
option comes back.

## Q: What is batch mode?
"MAKE SEVERAL AT ONCE · HALF PRICE" queues up a set of images and runs them together at half the
normal rate. You build the set in a tray called "YOUR BATCH".

## Q: Why is batch half price?
Because the work is submitted together and processed without holding a live connection open, so it
costs less to serve and that saving is passed on.

## Q: How many images can I put in a batch?
Up to 50 on a guest account and up to 200 on the owner account, counted over a 24 hour window.

## Q: How many images can I make at once normally?
Outside batch mode, up to four images per request.

## Q: What happens if my batch fails?
If a batch fails, expires or is cancelled, the submission charge is refunded in full, once, and the
row is labelled "FAILED · REFUNDED".

## Q: Do I get charged the estimate or the real cost for a batch?
You are charged at submission and then settled against what it actually used. If it came in cheaper
the difference is refunded, and if dearer the shortfall is charged.

## Q: What does an image cost?
It depends on quality and shape, from well under a cent for a low-quality square up to about twenty
cents for a high-quality wide image. Batch mode halves it.

## Q: Are image charges rounded up?
No. Image charges are exact and fractional, with no minimum per image, so a cheap draft really does
cost a fraction of a credit.

## Q: Where are my images kept?
In a gallery on the Foundry screen, stored locally in your browser. Dominion does not keep your
images on the server.

## Q: Are my images stored on your servers?
No. Live results stream straight to your browser, and batch results are only held long enough to hand
them to you before being removed.

## Q: Can I download my images?
Yes. Every image has a DOWNLOAD action, and there are also options to save straight to a folder or to
your photos depending on your device.

## Q: What is Save to folder?
On a desktop Chromium browser you can pick a real folder once and have new images written into it
automatically as they are made.

## Q: What is Save to photos?
On a phone it hands the image to your normal share sheet so you can put it in your camera roll or
anywhere else.

## Q: Why does an image say unsaved?
Your browser's local storage refused the write, so the picture is on screen but not kept. Long-press
it to save it before you navigate away.

## Q: Why did my image not get written to my folder?
The folder permission needs reconnecting, and the app says so plainly rather than pretending it
saved. There is a RECONNECT action right there.

## Q: Can I search my image gallery?
Yes, there is a search box, plus filters for all images, favourites, and batch results.

## Q: Can I favourite an image?
Yes, and the star filter shows only your favourites.

## Q: Can I delete all my images?
Yes, there is a DELETE ALL action for the gallery. It clears the local store, so be sure first.

## Q: Can I set a random seed?
No. Seed control is not exposed in the Foundry, so re-running the same description gives you a fresh
interpretation rather than an identical repeat.

## Q: Can I use a negative prompt?
No, there is no negative prompt field. Describe what you do want rather than what you do not, which
works better with these engines anyway.

## Q: Are there style presets?
No preset buttons. Style is carried entirely in your description, or by adding reference images whose
look you want copied.

## Q: Can I upscale an image?
No, upscaling is not built into the Foundry. Choose the HIGH quality setting and the larger shape if
you need maximum detail.

## Q: Can I edit part of an image or use a mask?
No, there is no inpainting or masking. You can steer a new generation with reference images, but you
cannot paint over a region of an existing one.

## Q: Why did my image request get refused?
Every description passes a content check before it runs. If it is refused you get a clear block
rather than a silent failure or a mangled picture.

## Q: What happens if image generation fails?
It stops and tells you, with the reason. There is no automatic switch to another provider, so you
know exactly which engine produced or failed to produce your picture.

## Q: Why does it say image generation is not configured?
The server has no key for the image provider yet. It is a setup gap rather than something wrong with
your request.

## Q: What makes Dominion's image generation different?
Three things that are unusual together: a genuinely free lane at zero cost, no server-side storage of
your pictures, and no watermark on the output.

## Q: Why does this app have a free image option when others do not?
Because a free lane on hardware that is already available costs Dominion effectively nothing to
offer, and being able to iterate without watching a meter is worth more than a slightly better
first draft.

## Q: Why are there two image engines instead of one?
They serve different moments. The free one is for exploring an idea cheaply, and the paid one is for
the version you are actually going to use.

## Q: Should I write long or short image prompts?
Long enough to name the subject, the setting, the lighting and the style, and no longer. Vague
prompts get generic pictures, and padding with adjectives past a point stops helping.

## Q: How do I get a consistent look across several images?
Reuse the same descriptive language for style and lighting each time, and add one of your earlier
images as a reference so the engine copies its look.

## Q: How do I make an image for a phone screen?
Use PORTRAIT at 2:3, which is the tall shape at 1024 by 1536.

## Q: How do I make a wide banner image?
Use LANDSCAPE at 3:2, which gives you 1536 by 1024.

## Q: Why do my images look different each time I run the same prompt?
Because there is no fixed seed, so each run is a fresh interpretation. Add a reference image if you
need the look to stay put.

## Q: Can I use these images commercially?
The output is yours as far as Dominion is concerned, with no watermark and no branding applied.
Check the terms of the underlying provider for anything legally significant.

## Q: Does using the free lane cost me credits?
No, nothing at all. The free lane is not metered, so your balance does not move.

## Q: How do credits work for images?
One hundred credits is a dollar of value, and image charges are exact, so a low-quality draft costs a
fraction of a credit rather than a whole one.

## Q: Can I make an image from a chat conversation?
The Foundry is its own screen with its own description box. Copy the idea across, or ask me to open
The Foundry for you.

## Q: Why is my batch taking a while?
Batches are processed together rather than held on a live connection, which is why they are half
price. The tray shows their state as they land.

## Q: Can I cancel a batch?
A batch that ends up cancelled refunds its submission charge in full, so stopping one does not cost
you the money you put in.
