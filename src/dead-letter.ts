export const deadLetterPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Dead-letter jobs</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #f4f1eb; color: #25221e; }
      main { max-width: 960px; margin: 0 auto; padding: 2rem 1rem 4rem; }
      h1 { margin-bottom: .35rem; }
      #status { color: #625b52; }
      .job { background: #fff; border: 1px solid #d9d0c5; border-radius: 10px; margin: 1rem 0; padding: 1rem; }
      .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .5rem; margin: .75rem 0; }
      .label { color: #625b52; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
      pre { background: #f4f1eb; overflow: auto; padding: .75rem; border-radius: 6px; }
      button { background: #25221e; border: 0; border-radius: 6px; color: white; cursor: pointer; padding: .6rem .9rem; }
      button:disabled { cursor: wait; opacity: .55; }
      .error { color: #a52d25; }
    </style>
  </head>
  <body>
    <main>
      <h1>Dead-letter jobs</h1>
      <p id="status">Loading dead jobs...</p>
      <section id="jobs" aria-live="polite"></section>
    </main>
    <script>
      const status = document.getElementById("status");
      const jobs = document.getElementById("jobs");
      const formatDate = (value) => value ? new Date(value).toISOString() : "-";
      const field = (label, value) => {
        const wrapper = document.createElement("div");
        const heading = document.createElement("div");
        heading.className = "label";
        heading.textContent = label;
        const text = document.createElement("div");
        text.textContent = value;
        wrapper.append(heading, text);
        return wrapper;
      };
      async function loadJobs() {
        status.className = "";
        status.textContent = "Loading dead jobs...";
        jobs.replaceChildren();
        try {
          const response = await fetch("/api/v1/jobs/dead");
          if (!response.ok) throw new Error("Could not load dead jobs");
          const body = await response.json();
          if (body.data.length === 0) {
            status.textContent = "No dead jobs.";
            return;
          }
          status.textContent = body.data.length + " dead job(s)";
          for (const job of body.data) {
            const article = document.createElement("article");
            article.className = "job";
            const title = document.createElement("h2");
            title.textContent = job.id;
            const meta = document.createElement("div");
            meta.className = "meta";
            meta.append(
              field("Type", job.type),
              field("Attempts", job.attempts + "/" + job.maxAttempts),
              field("Failed", formatDate(job.finishedAt)),
              field("Output", job.outputPath || "-")
            );
            const error = document.createElement("p");
            error.textContent = job.lastError || "No error recorded";
            const payload = document.createElement("pre");
            payload.textContent = JSON.stringify(job.payload, null, 2);
            const retry = document.createElement("button");
            retry.textContent = "Retry job";
            retry.addEventListener("click", async () => {
              retry.disabled = true;
              try {
                const result = await fetch("/api/v1/jobs/" + encodeURIComponent(job.id) + "/retry", { method: "POST" });
                if (!result.ok) throw new Error("Retry failed");
                await loadJobs();
              } catch (retryError) {
                retry.disabled = false;
                status.className = "error";
                status.textContent = retryError.message;
              }
            });
            article.append(title, meta, error, payload, retry);
            jobs.append(article);
          }
        } catch (error) {
          status.className = "error";
          status.textContent = error.message;
        }
      }
      loadJobs();
    </script>
  </body>
</html>`;
