import { useEffect, useState } from "react";

type HealthState = "checking" | "available" | "unavailable";

const healthLabels: Record<HealthState, string> = {
  checking: "Checking API…",
  available: "API is responding",
  unavailable: "API is unavailable",
};

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        const payload: unknown = await response.json();
        if (
          !response.ok ||
          typeof payload !== "object" ||
          payload === null ||
          !("status" in payload) ||
          payload.status !== "ok"
        ) {
          throw new Error("Unexpected health response");
        }

        if (!controller.signal.aborted) setHealth("available");
      } catch {
        if (!controller.signal.aborted) setHealth("unavailable");
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="page-shell">
        <header className="site-header">
          <span className="wordmark">Chess Room</span>
          <span className="stage-label">Development foundation</span>
        </header>

        <main id="main" tabIndex={-1}>
          <section className="hero" aria-labelledby="page-heading">
            <div className="hero-copy">
              <p className="eyebrow">A shared table. A new game.</p>
              <h1 id="page-heading">Chess starts with company.</h1>
              <p className="introduction">
                A space for online chess with friends, with room for new ways to play. The
                development environment is ready; gameplay is coming in later milestones.
              </p>
            </div>

            <aside className="service-card" aria-labelledby="service-heading">
              <p className="eyebrow">Environment check</p>
              <h2 id="service-heading">Web &amp; API</h2>
              <output
                className={`service-status service-status--${health}`}
                aria-live="polite"
                aria-atomic="true"
              >
                <span className="status-dot" aria-hidden="true" />
                {healthLabels[health]}
              </output>
              <p>
                This checks whether the API process responds. Game services and persistence are
                planned.
              </p>
              {health === "unavailable" && (
                <p className="service-help">
                  Start both development services, then reload this page.
                </p>
              )}
            </aside>
          </section>

          <section className="direction" aria-labelledby="direction-heading">
            <div className="section-heading">
              <h2 id="direction-heading">What comes next</h2>
              <p>Planned experiences</p>
            </div>
            <div className="direction-grid">
              <article>
                <span className="item-number" aria-hidden="true">
                  01
                </span>
                <h3>Play with a friend</h3>
                <p>Create a private game and invite someone to join you at the board.</p>
              </article>
              <article>
                <span className="item-number" aria-hidden="true">
                  02
                </span>
                <h3>Stay in the game</h3>
                <p>Share a consistent game state and reconnect when a connection drops.</p>
              </article>
              <article>
                <span className="item-number" aria-hidden="true">
                  03
                </span>
                <h3>Explore new rules</h3>
                <p>Build on standard chess with carefully defined, tested game modes.</p>
              </article>
            </div>
          </section>
        </main>

        <footer className="site-footer">
          <p>Chess Room</p>
          <p>Environment setup only · Online play is planned</p>
        </footer>
      </div>
    </>
  );
}
