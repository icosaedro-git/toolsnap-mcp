---
title: "By reference, not by copy: why ToolSnap never stores your data"
date: 2026-07-14
category: "Engineering"
tags: ["privacy", "security", "data"]
read_time: 5
featured: true
description: "ToolSnap's data tools process your files in memory for milliseconds and store nothing. Here is how that works, what we log, and how to keep sensitive data entirely under your own control."
---

Ask an agent to filter a 40 MB CSV and two worries show up at once. The first is the context bill: an LLM cannot hold a file that size, and even if it could, you would not want to pay to re-send it on every turn. The second is quieter but just as real: where does that file end up once you hand it to a tool?

We built ToolSnap to answer both with the same design decision.

### How it actually works

You pass a URL. We fetch it, run your query or extraction server-side, and return only the result. The file lives in the Worker's memory for the duration of that one request and nothing else touches it: no database write, no cache, no queue. By the time our response reaches you, the source content is already gone on our end.

We measured this pattern once before, on plain page extraction: asking an agent to read an ordinary article page put 53,820 tokens into its context. Running the same page through `fetch_extract` returned 2,001 tokens, a 98.1% reduction. The same principle applies to every data tool in the catalog: `csv_query`, `json_query`, `pdf_text_extract`, and the rest. Operate by reference, not by copy.

### What we log (and what we refuse to)

Honesty is easier when there is less to hide. Here is the complete list of what we log per call: tool name, timestamp, latency, and payment metadata. That's it. We never log the URL you fetched, the content of the file, or the arguments of the call. On a failed call, we log the error message text and nothing more about the request.

If our database leaked tomorrow, your data would not be in it, because it was never there.

### Keep the keys: bring your own storage

For anything sensitive enough that "we don't keep it" isn't reassurance on its own, don't send us a public link at all. Generate a short-lived, read-only URL from storage you already control and pass that instead.

- **Enterprise with S3, GCS, or Azure Blob:** issue a presigned GET URL that expires in minutes. Your security team keeps full control of access; we only see bytes in transit, once.
- **Team on Cloudflare:** an R2 presigned URL or a bucket with a short-lived token works the same way.
- **Indie or solo developer:** any static hosting you already use, or GitHub raw for data that isn't sensitive.
- **Small file already in the agent's hands:** skip hosting entirely and pass it inline (the `csv` parameter on `csv_query`, for example). No upload needed for something that small.

A real command, not a hypothetical one:

```
aws s3 presign s3://your-bucket/data.csv --expires-in 300
```

That gives you a URL valid for five minutes. Hand it to the tool, and the file never reposes on ToolSnap at any point.

### Big files, same promise

Some files are bigger than the free tier's 5 MB cap. `csv_query_xl` streams up to 100 MB and `json_query_xl` handles up to 25 MB, both for $0.02 a call. Streaming means the file is still never buffered whole and never touches your context: we just raised the ceiling, we did not change the promise. Try the free `csv_query` or `json_query` first; when a file outgrows 5 MB, the tool tells you exactly how to move to the paid sibling.

### Try it

Connect once, at `https://mcp.toolsnap.app/mcp`, and ask your agent to run `csv_query` on your next export. Full detail on retention and subprocessors lives on our [Security &amp; Data Handling](/security) page.
