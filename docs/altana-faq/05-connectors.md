# Altana FAQ: connectors and outside services

Opening answers about wiring Dominion to the services you already use. What a connector can reach is
always bounded by the credential you give it, which is the honest short answer to most of these.

## Q: How do I connect my Dominion AI to my GitHub?
Open "Setup · Connectors & Credits" from the sidebar, switch GitHub on, and paste a personal access
token. What Dominion can then reach is exactly what that token allows, and nothing more.

## Q: What can Dominion do with GitHub once connected?
Work with your repositories, issues and pull requests, and search code. The scope is whatever
permissions you granted the token you pasted.

## Q: What GitHub token do I need?
A personal access token from your GitHub account settings. Give it only the repositories and
permissions you actually want reachable, because that token is the whole boundary.

## Q: Can Dominion push code to GitHub for me?
Only if the token you gave it has write access. If you paste a read-only token it can read and search
but cannot change anything.

## Q: Does building an app push it to GitHub automatically?
No. The app builder writes files into a folder on your own computer and commits to a local build
branch. Publishing to GitHub is a separate, deliberate step.

## Q: What connectors are available?
Web search and reader, your own machine, GitHub, Google Workspace, Supabase, Stripe, Postgres,
Zapier, Railway, Cloudflare, and any custom MCP server you add yourself.

## Q: Where do I set up connectors?
"Setup · Connectors & Credits" in the sidebar. Each row has a toggle, its credential fields, and a
Test button so you can prove it works before relying on it.

## Q: How do I know a connector actually works?
Press its Test button after entering credentials. That is there so a broken connector fails in front
of you rather than in the middle of real work.

## Q: Is web search always on?
Yes. Web search and the page reader are built in for every account and cannot be switched off.

## Q: Can Dominion read a web page for me?
Yes, the reader is built in. Give it a link and it can fetch and read the page.

## Q: What is the Your machine connector?
It is the reach into your own computer through the Dominion node you installed: reading files and
running commands in the folders you point it at. It is what makes the app builder possible.

## Q: What can Dominion do with Google Workspace?
Read side: search and read Gmail, list your calendar, search and read Drive, and read Sheets. Write
side: send mail, create calendar events, append to Sheets, and create Docs.

## Q: Can Dominion delete my emails or files?
No. There is no delete verb anywhere in the Google connector, deliberately. It can read, send and
create, but removing things is not something it is able to do.

## Q: Will Dominion send an email as me?
Only if you ask it to. Sending goes out immediately as the account holder, which is exactly why it is
worth being explicit about who you are mailing and why.

## Q: Can Dominion read my calendar?
Yes, it can list your calendar events once Google Workspace is connected. Creating events is also
supported, but nothing is deleted.

## Q: Can Dominion work with Google Sheets?
It can read a sheet and append rows to it. It does not overwrite or delete existing rows.

## Q: Can Dominion create Google Docs?
Yes, document creation is one of the write verbs in the Google connector.

## Q: How do I connect Google Workspace?
It uses a proper OAuth sign-in rather than a pasted key, so you press Connect and approve it in
Google's own screen.

## Q: Why can I not use Google Workspace on my account?
Google Workspace is off by default for guest accounts. It is the owner's decision whether to open it
up.

## Q: Can Dominion use Google Maps?
Yes, there are Maps tools available through the Google connector for place and location work.

## Q: Can Dominion query BigQuery?
Yes, there are BigQuery tools for running queries against your datasets once Google is connected.

## Q: What can Dominion do with Supabase?
Run SQL, inspect tables, apply migrations, read logs and work with edge functions. It runs a local
helper process to do it.

## Q: What can Dominion do with Stripe?
Look at customers, payments, invoices and subscriptions. Remember that I personally will not touch
anything billing-related, so that connector is for your own direct work rather than for me.

## Q: What can Dominion do with Postgres?
Read-oriented SQL against a Postgres database you connect. It is aimed at querying and understanding
rather than restructuring.

## Q: What is the Zapier connector?
It is a bridge to a Zapier endpoint you supply with a URL and token. What it can reach depends
entirely on which actions you enabled inside Zapier itself.

## Q: Is the Railway connector reliable?
It is flagged experimental and runs against a community-maintained server, so treat it as useful but
not guaranteed.

## Q: Is the Cloudflare connector reliable?
Same as Railway: it is marked experimental and community-maintained. It works, but it is not held to
the same standard as the first-party ones.

## Q: Can I connect Vercel?
Not yet. Vercel is listed but marked as not wired up, and it cannot be toggled on. It is a placeholder
rather than a working connector.

## Q: Can I add my own connector?
Yes. "Add connector" accepts any MCP server you paste in, so anything speaking that protocol can be
wired in yourself.

## Q: What is MCP?
It is the open protocol these connectors speak, so a tool built for it can be plugged into Dominion
without Dominion needing custom code for it.

## Q: Why did my connector fail to start?
Some connectors run a local helper through npm. If the machine has no npm available they cannot
start, and that is the usual cause.

## Q: How many tools can one connector add?
Up to 40 tools are injected per connector. That ceiling keeps one very large connector from crowding
out everything else.

## Q: Are my connector credentials safe?
They are encrypted at rest with AES-256-GCM. They are also never shown back to you or to me in full.

## Q: Can Altana see my API keys?
No. Credentials, keys, tokens and connector secrets are one of the categories I have no tools for at
all, and they are redacted before anything reaches me.

## Q: Do guests use the owner's connector credentials?
Never. A guest must paste their own credentials, and the server's own keys are never lent out to
another account.

## Q: Can a connector touch my backups?
No. Any call that reaches for backup drives or a database dump is refused for every account,
including the owner's.

## Q: Can I turn a connector off again?
Yes, each row has a toggle. Switching it off removes its tools from what the assistant can reach.

## Q: Do connectors work in the app builder too?
The builder's own reach into your machine is the node connector. Other connectors are available to
the assistant and to chat turns that need them.

## Q: What happens if a connector has no credentials?
It stays unavailable rather than half-working, and the row tells you what is missing. Nothing silently
runs with the wrong account.

## Q: Can Dominion access my computer without me installing anything?
No. Reaching your machine requires the Dominion node installed and running on that computer, and it
only works while it is running.

## Q: Does the node run in the background all the time?
For a guest's self-serve install, no: it only works while its window is open, and it installs no
background service and needs no admin rights.

## Q: Which connectors can change things versus only read?
GitHub, Google, Supabase, Stripe and Zapier can change things within the scope you granted. Postgres
is read-oriented, and web search and the reader are read-only by nature.

## Q: How do I limit what Dominion can do to a service?
Give it a narrower credential. A read-only token, a restricted scope or a limited-permission service
account is far more reliable than asking it nicely.

## Q: Can Dominion open a pull request for me?
With a GitHub token that has the right permissions, yes. With a read-only token it can prepare the
work but not publish it.

## Q: Can Dominion search across my code?
Yes, code search is part of the GitHub connector, so it can look through the repositories your token
can see.

## Q: Can Dominion read my private repositories?
Only the ones your token grants access to. If you scope the token to specific repositories, that is
exactly what it can see.

## Q: Do I need GitHub to use the app builder?
No. The builder writes to a folder on your own machine and uses local git for its safety branches.
GitHub is only needed if you want to publish.

## Q: Can Dominion deploy to Vercel or Railway?
Not as a guided flow. The Vercel connector is not wired yet, Railway is experimental, and the
builder's own put-it-online step is honestly marked as not built.

## Q: What is the safest way to try a connector?
Connect it with the narrowest credential that could possibly work, press Test, and ask for a read-only
task first. Widen it only once you have seen it behave.

## Q: Does connecting a service send it all my chats?
No. A connector is a set of tools that get called when they are needed, not a pipe that streams your
conversation anywhere.

## Q: Can I see what a connector actually did?
Yes, the Tool Activity panel logs the tool calls that ran on your behalf, so there is a record rather
than a mystery.
