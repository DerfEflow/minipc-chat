# Altana FAQ: account, credits, privacy and reliability

Opening answers about money, data and what happens when something breaks. I do not touch billing
myself, so these entries explain how it works and then point at the Billing screen.

## Q: How does pricing work?
Dominion runs on credits. One hundred credits is one dollar of model value at cost, and credits are
sold at a 25% markup, so $1.25 buys 100 credits.

## Q: What is the minimum I can top up?
$12.50 is the smallest top-up. The offered amounts are $12.50, $25, $50 and $100.

## Q: How do I buy credits?
Use "Buy credits" on the Setup screen. I cannot do this part for you, because billing is deliberately
outside what I am allowed to touch.

## Q: Why can Altana not add credits for me?
Because anything to do with payment, cards, invoices, budgets or credits is off limits to me by
design, not by accident. It keeps a chatty assistant well away from your money.

## Q: What is auto-recharge?
When your balance drops to 100 credits or below, the account tops itself up automatically so work in
progress does not die mid-task. It is required rather than optional.

## Q: What happens if my card fails?
It retries a few times over roughly three days. After three failures the account is locked rather
than silently running up a debt.

## Q: My account is locked. Why?
The most common reason is three failed auto-recharge attempts. Fixing the payment method on the Setup
screen is what unlocks it.

## Q: Am I charged for a turn that cost nothing?
No. Charges are exact and fractional, and a zero-cost turn deducts zero. There is no minimum charge
padding out cheap work.

## Q: Are charges rounded up to whole credits?
No, they are fractional and exact. A tiny turn costs a tiny fraction of a credit.

## Q: What is a DOMI code?
It is a single-use access code in the form DOMI-XXXX-XXXX. There are two kinds: an invite code that
comes with credit, and a free sponsored code.

## Q: What is a sponsored free account?
It is an account opened with a free code, with a monthly ceiling of about $20 of usage. It is a real
account, just with a cap on what it can spend on someone else's behalf.

## Q: When do my invite credits appear?
Promotional credits attached to an invite code are held until your first real purchase, and released
then. That is to stop the code being farmed without anyone ever becoming a customer.

## Q: How do I see what I have spent?
The session budget box shows spent against budget on the chat screen, and builds show their own
running cost. Setup has your credit balance.

## Q: How do I stop a build spending too much?
Set a figure in "Stop this project at" before you press build. It pauses and asks before it would
pass that number.

## Q: What if I leave the build spend limit blank?
Then nothing stops it on cost, and the screen tells you so directly. Blank means no limit, not a
sensible default.

## Q: Are cost estimates accurate?
They are estimates built from real measured rates, shown as a range, and labelled as estimates. They
are honest guidance rather than a quote.

## Q: What is the cheapest way to use Dominion?
Stay on the free lane models for ordinary work, use the free draft engine for images, keep the Forge
Dial on Ember, and only reach for the big models when the job actually needs one.

## Q: Are free models really free?
Yes. The free lane is priced at zero and not metered, so using it does not move your balance at all.

## Q: Why is there a free lane at all?
Because a lot of work does not need a frontier model, and being able to iterate without watching a
meter makes the whole app more useful. The paid models are there for when the work earns them.

## Q: What are the privacy modes?
Three: Normal, which allows all providers; Trusted, which restricts to OpenAI and Anthropic direct;
and Private, which is Anthropic direct only.

## Q: What does Trusted mode actually change?
It limits which companies your text may reach, restricting the turn to direct OpenAI and Anthropic
connections rather than the wider pool.

## Q: Does Private mode mean nothing leaves my machine?
No, and any wording suggesting otherwise is out of date. Private means Anthropic direct only. It is a
narrower set of providers, not local-only processing.

## Q: What happens if my privacy mode blocks the model I picked?
The turn is refused with a clear message. Dominion never quietly reroutes you to a provider your
privacy mode excludes.

## Q: Why can I not choose Private mode?
Private is limited to the owner's account. Guests get Normal and Trusted.

## Q: Is my chat text scrubbed before it goes to a model?
No, and this is worth being straight about: your ordinary chat text is sent as you wrote it. The
redaction layer protects what gets fed to me and to tool results, not your own typed messages.

## Q: What exactly is redacted?
Around fifteen categories in the context assembled for me and in tool results: private keys, tokens,
API keys, auth headers, card numbers, national ID numbers, phone numbers, emails, file paths,
private IP addresses and high-entropy strings.

## Q: Does Altana see my API keys?
No. Secrets are stripped before the context reaches me, and I have no tools that could fetch them
anyway.

## Q: How long is my data kept?
Connector secrets stay encrypted until you remove them, artifacts keep every version, and uncollected
chat results persist for weeks unless retention is set to keep them forever.

## Q: Does Dominion train on my data?
Your work is yours. Dominion stores what you asked it to store so you can come back to it, and the
providers' own terms govern what happens at their end.

## Q: Can anyone else see my conversations?
No. Accounts are isolated from each other, and access tokens are stored hashed rather than in the
clear.

## Q: Are there backups?
Yes, encrypted nightly backups with AES-256-GCM. That is about surviving a disk failure rather than
about anyone reading your work.

## Q: What happens if a model provider goes down?
The turn moves to another route rather than dying. For a direct-provider failure the same model is
retried through a different path, and it is always reported rather than hidden.

## Q: Will it swap my model for a cheaper one without telling me?
Never. Dominion does not silently substitute a different or cheaper model. Any change of engine is
stated in the log.

## Q: What errors are worth retrying?
Timeouts, rate limits and server errors are treated as transient and retried with a backoff. Running
out of funds is permanent for that provider, so it reroutes instead of hammering.

## Q: What happens if my provider account runs out of money mid-build?
That step moves to a different provider that still has credit, and says so out loud. The build
carries on rather than stopping dead.

## Q: Which model does Altana use?
I run on a fast paid seat by default, with a free but slower seat as a fallback. If I fall back to
the slow one, I say so, so you know why I am taking longer.

## Q: Why was Altana slow that time?
Most likely my main seat was unreachable and I fell back to the free lane, which is much slower. It
is a deliberate trade: a slow answer beats a dark assistant.

## Q: What happens if Altana cannot reach her own brain?
I say so plainly and ask you to try again. I will not fabricate an answer to cover a failed call.

## Q: What happens to a job if the server restarts?
Build jobs are journalled to disk, so the record survives a restart and the work already written is
still on your machine. A build interrupted that way is marked interrupted rather than pretending to
have finished.

## Q: Does a paused build cost me anything?
No. A build waiting on a question spends nothing while it waits.

## Q: What is the difference between the owner account and a guest?
The owner has the full model catalog, Private privacy mode, higher batch ceilings and access to
everything. Guests get a capable subset and must bring their own connector credentials.

## Q: Do I need an access code to use Dominion?
Guest accounts need an invite or free code to get in. That is what keeps a private console private.

## Q: How do I contact a human?
Tell me and I will log it for the team with your permission, including whether you want to be
contacted back. It reaches Fred directly.

## Q: Will you tell me if something went wrong rather than guessing?
Yes, always. The whole app is built around refusing to claim an outcome it cannot actually see, and I
work the same way.

## Q: What does Dominion do that is genuinely unusual?
It refuses rather than substitutes on privacy, it charges exact fractional costs with real free
lanes, it shows estimates as ranges instead of fake precision, its jobs survive a restart, and your
code stays in your own folder on your own machine.

## Q: Why does the app keep telling me what it cannot do?
Because a tool that overstates itself is worse than one with a short honest list. You can plan around
a known limit, but you cannot plan around a pleasant lie.

## Q: Can I set a spending cap for a chat session?
Yes, the session budget on the chat screen has a Set control, and it warns you and offers to raise it
or add credits when you reach it.

## Q: Does the model I pick change what it costs?
Substantially. Model pricing varies by more than an order of magnitude, which is why the picker
shows the cost and why the free lane exists.

## Q: How can I tell if a model is free before I use it?
The picker marks it, and cost estimates render as "Free" rather than a number. If it is priced, you
see a range.

## Q: Do images and video use the same credits as chat?
Yes, one credit system across everything, at the same one hundred credits to the dollar.

## Q: Why did my batch of images get refunded?
A batch that fails, expires or is cancelled refunds its submission charge in full, once. You are only
ever settled against what actually ran.
