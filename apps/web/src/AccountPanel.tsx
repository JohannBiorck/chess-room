import {
  type AccountStatus,
  accountStatusSchema,
  type CatEffect,
  type HistoryItem,
  type HistoryList,
  historyListSchema,
  type MoveRecord,
  RULESETS,
} from "@chess-room/contracts";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, request } from "./api";
import { Modal } from "./Modal";
import { Piece, type PieceKind, pieceNames } from "./Piece";
import {
  applyAccountPresentationPreferences,
  getPresentationPreferences,
  subscribePresentationPreferences,
} from "./presentationPreferences";
import "./account.css";

type RecoveryKit = { locator: string; codes: string[] };
type SavedGame = {
  game: HistoryItem;
  initialFen: string;
  positions: Array<{ fen: string; move: MoveRecord; catEffect?: CatEffect }>;
  players: { white: { displayName: string }; black: { displayName: string } };
};
type ActiveGame = { id: string; rulesetId: string; phase: string; opponentName: string | null };
const modeName = (id: string) => RULESETS.find((rule) => rule.id === id)?.label ?? id;
function downloadKit(kit: RecoveryKit) {
  const blob = new Blob(
    [
      `Cat Chess recovery kit\nAccount: ${kit.locator}\n\nSingle-use recovery codes:\n${kit.codes.join("\n")}\n\nKeep this file private. Losing every passkey and every code loses access.\n`,
    ],
    { type: "text/plain" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "cat-chess-recovery.txt";
  link.click();
  URL.revokeObjectURL(url);
}
function ReadonlyBoard({ fen, orientation }: { fen: string; orientation: "white" | "black" }) {
  const board = useRef<HTMLTableElement>(null);
  useEffect(() => {
    board.current?.scrollIntoView({ block: "end" });
  }, []);
  const cells: Array<{
    square: string;
    piece: { type: PieceKind; color: "white" | "black" } | null;
  }> = [];
  const rows = fen.split(" ")[0]?.split("/") ?? [];
  for (let rank = 0; rank < 8; rank++) {
    let file = 0;
    for (const symbol of rows[rank] ?? "") {
      if (/[1-8]/.test(symbol)) {
        for (let n = 0; n < Number(symbol); n++)
          cells.push({ square: `${"abcdefgh"[file++]}${8 - rank}`, piece: null });
      } else if (/[pnbrqk]/i.test(symbol)) {
        cells.push({
          square: `${"abcdefgh"[file++]}${8 - rank}`,
          piece: {
            type: symbol.toLowerCase() as PieceKind,
            color: symbol === symbol.toUpperCase() ? "white" : "black",
          },
        });
      }
    }
  }
  const squares = orientation === "white" ? cells : [...cells].reverse();
  return (
    <table ref={board} className="account-replay-board" aria-label="Saved game board">
      <tbody>
        {["8", "7", "6", "5", "4", "3", "2", "1"].map((rank, r) => (
          <tr key={rank}>
            {squares.slice(r * 8, r * 8 + 8).map((cell, c) => (
              <td
                key={cell.square}
                className={(r + c) % 2 ? "dark" : "light"}
                aria-label={`${cell.square}${cell.piece ? `, ${cell.piece.color} ${pieceNames[cell.piece.type]}` : ", empty"}`}
              >
                {cell.piece && <Piece {...cell.piece} />}
                <span>{cell.square}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
export function AccountPanel({
  onIdentityChanged,
  onResumeGame,
  onAccountChanged,
}: {
  onIdentityChanged: () => Promise<void> | void;
  onResumeGame?: (id: string) => void;
  onAccountChanged?: (signedIn: boolean) => void;
}) {
  const callbacks = useRef({ onIdentityChanged, onResumeGame, onAccountChanged });
  callbacks.current = { onIdentityChanged, onResumeGame, onAccountChanged };
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"account" | "history">("account");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [keepGuest, setKeepGuest] = useState(true);
  const [recovery, setRecovery] = useState<RecoveryKit | null>(null);
  const [locator, setLocator] = useState("");
  const [code, setCode] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [passkeys, setPasskeys] = useState<Array<{ id: string; label: string; createdAt: number }>>(
    [],
  );
  const [active, setActive] = useState<ActiveGame[]>([]);
  const [history, setHistory] = useState<HistoryList>({ games: [], nextCursor: null });
  const [filter, setFilter] = useState("");
  const [opponentFilter, setOpponentFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [saved, setSaved] = useState<SavedGame | null>(null);
  const [ply, setPly] = useState(0);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const signedIn = useRef(false);
  const loadEpoch = useRef(0);
  const historyEpoch = useRef(0);
  const preferenceEpoch = useRef(0);
  const preferenceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const appliedPreferences = useRef(false);
  const privateData = useRef(false);
  const clearPrivateRecords = useCallback((nextRecovery: RecoveryKit | null = null) => {
    historyEpoch.current += 1;
    preferenceEpoch.current += 1;
    if (preferenceTimer.current) clearTimeout(preferenceTimer.current);
    preferenceTimer.current = undefined;
    signedIn.current = false;
    appliedPreferences.current = false;
    setHistory({ games: [], nextCursor: null });
    setPasskeys([]);
    setActive([]);
    setSaved(null);
    setPly(0);
    setRecovery(nextRecovery);
    setLocator("");
    setCode("");
    setDisplayName("");
    setRecovering(false);
    setDeleteConfirmation(false);
    privateData.current = nextRecovery !== null;
  }, []);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    const next = accountStatusSchema.parse(await request("/api/account"));
    if (epoch !== loadEpoch.current) return;
    setStatus(next);
    signedIn.current = next.account !== null;
    callbacks.current.onAccountChanged?.(signedIn.current);
    if (next.account) {
      privateData.current = true;
      if (!appliedPreferences.current) {
        applyAccountPresentationPreferences(next.account.preferences);
        appliedPreferences.current = true;
      }
      const [keys, games] = await Promise.all([
        request<{ credentials: typeof passkeys }>("/api/account/passkeys"),
        request<{ games: ActiveGame[] }>("/api/account/games"),
      ]);
      if (epoch !== loadEpoch.current) return;
      setPasskeys(keys.credentials);
      setActive(games.games);
    } else {
      if (privateData.current) clearPrivateRecords();
    }
  }, [clearPrivateRecords]);
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) setError(errorMessage(e));
    });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    const unsubscribe = subscribePresentationPreferences(() => {
      if (!signedIn.current) return;
      if (preferenceTimer.current) clearTimeout(preferenceTimer.current);
      const epoch = preferenceEpoch.current;
      preferenceTimer.current = setTimeout(() => {
        if (!signedIn.current || epoch !== preferenceEpoch.current) return;
        const { volume, motion } = getPresentationPreferences();
        void request("/api/account/preferences", { volume, motion }).catch((e) =>
          setError(errorMessage(e)),
        );
      }, 750);
    });
    return () => {
      unsubscribe();
      if (preferenceTimer.current) clearTimeout(preferenceTimer.current);
    };
  }, []);
  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);
  const changed = async (nextRecovery: RecoveryKit | null = null) => {
    clearPrivateRecords(nextRecovery);
    setStatus(null);
    loadEpoch.current += 1;
    await callbacks.current.onIdentityChanged();
    await load();
  };
  const endIdentity = async (path: string, method: "POST" | "DELETE" = "POST") => {
    clearPrivateRecords();
    setStatus(null);
    loadEpoch.current += 1;
    try {
      await request(path, method === "POST" ? {} : undefined, method);
    } finally {
      await changed();
    }
  };
  async function ceremony(
    purpose: "registration" | "login" | "reauth" | "add-passkey" | "recover",
  ) {
    const { volume, motion } = getPresentationPreferences();
    if (!browserSupportsWebAuthn())
      throw new Error("This browser cannot use passkeys. You can continue playing as a guest.");
    const begun = await request<{
      flowId: string;
      options: PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
    }>(
      `/api/auth/${purpose}/options`,
      purpose === "registration" ? { displayName, keepGuestGames: keepGuest } : {},
    );
    try {
      const response =
        purpose === "registration" || purpose === "add-passkey" || purpose === "recover"
          ? await startRegistration({
              optionsJSON: begun.options as PublicKeyCredentialCreationOptionsJSON,
            })
          : await startAuthentication({
              optionsJSON: begun.options as PublicKeyCredentialRequestOptionsJSON,
            });
      const result = await request<{ recovery: RecoveryKit | null }>("/api/auth/verify", {
        flowId: begun.flowId,
        response,
      });
      clearPrivateRecords(result.recovery);
      setStatus(null);
      loadEpoch.current += 1;
      if (purpose === "registration") {
        try {
          await request("/api/account/preferences", { volume, motion });
        } catch {
          setError("Your account is ready. Device preferences could not be saved yet.");
        }
      }
      await changed(result.recovery);
      setRecovering(false);
    } catch (e) {
      await request("/api/auth/cancel", { flowId: begun.flowId }).catch(() => undefined);
      throw e;
    }
  }
  const loadHistory = useCallback(
    async (cursor?: string) => {
      const epoch = ++historyEpoch.current;
      const query = new URLSearchParams({ limit: "20" });
      if (cursor) query.set("cursor", cursor);
      if (filter) query.set("ruleset", filter);
      if (opponentFilter) query.set("opponentKind", opponentFilter);
      if (resultFilter) query.set("result", resultFilter);
      const result = historyListSchema.parse(await request(`/api/account/history?${query}`));
      if (epoch !== historyEpoch.current) return;
      setHistory((previous) =>
        cursor
          ? { games: [...previous.games, ...result.games], nextCursor: result.nextCursor }
          : result,
      );
    },
    [filter, opponentFilter, resultFilter],
  );
  useEffect(() => {
    if (open && tab === "history" && status?.account) void run(() => loadHistory());
  }, [open, tab, status?.account, loadHistory, run]);
  const close = () => {
    if (busy) return;
    setOpen(false);
    setRecovery(null);
    setCode("");
    setLocator("");
    setDeleteConfirmation(false);
  };
  return (
    <>
      <button
        className="account-button button button--quiet button--small"
        type="button"
        onClick={() => {
          setOpen(true);
          void run(load);
        }}
      >
        {status?.account ? "Account & history" : "Sign in"}
      </button>
      {open && (
        <Modal
          title={tab === "history" ? "Match history" : "Your Cat Chess account"}
          onClose={close}
          closeDisabled={busy}
        >
          <div className="account-panel" aria-busy={busy}>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            {status?.account && (
              <nav className="account-tabs" aria-label="Account sections">
                <button
                  type="button"
                  aria-pressed={tab === "account"}
                  onClick={() => {
                    setTab("account");
                    setSaved(null);
                  }}
                >
                  Account
                </button>
                <button
                  type="button"
                  aria-pressed={tab === "history"}
                  onClick={() => setTab("history")}
                >
                  Match history
                </button>
              </nav>
            )}
            {recovery && (
              <section className="recovery-kit" aria-label="Your recovery kit">
                <h3>Save your recovery kit</h3>
                <p>
                  Keep these codes private. Each works once. This is the only time they are
                  displayed.
                </p>
                <p>
                  Account locator: <code>{recovery.locator}</code>
                </p>
                <ol>
                  {recovery.codes.map((code) => (
                    <li key={code}>
                      <code>{code}</code>
                    </li>
                  ))}
                </ol>
                <button type="button" onClick={() => downloadKit(recovery)}>
                  Download recovery kit
                </button>
                <button type="button" onClick={() => setRecovery(null)}>
                  I saved my codes
                </button>
              </section>
            )}
            {!status?.account && (
              <>
                <p>
                  Passkeys save your seat and match history across devices. Guest play stays
                  available.
                </p>
                <p className="account-hint">
                  Use a supported device or password manager. Some passkeys are tied to one device.
                  Save the recovery kit; there is no email reset.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(() => ceremony("registration"));
                  }}
                >
                  <label>
                    Account display name
                    <input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      maxLength={32}
                      required
                      autoComplete="nickname"
                    />
                  </label>
                  <label className="account-checkbox">
                    <input
                      type="checkbox"
                      checked={keepGuest}
                      onChange={(e) => setKeepGuest(e.target.checked)}
                    />
                    Keep this browser's eligible guest games
                  </label>
                  <p>History stores up to 500 games for 365 days. You can export your games.</p>
                  <button type="submit" disabled={busy}>
                    Create account with a passkey
                  </button>
                </form>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => ceremony("login"))}
                >
                  Sign in with a passkey
                </button>
                <button type="button" disabled={busy} onClick={() => setRecovering(!recovering)}>
                  Use a recovery code
                </button>
                {recovering && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => {
                        await request("/api/auth/recovery", { locator, code });
                        setCode("");
                        await ceremony("recover");
                      });
                    }}
                  >
                    <label>
                      Account locator
                      <input
                        required
                        value={locator}
                        onChange={(e) => setLocator(e.target.value)}
                        autoComplete="off"
                      />
                    </label>
                    <label>
                      Unused recovery code
                      <input
                        required
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="one-time-code"
                      />
                    </label>
                    <button disabled={busy} type="submit">
                      Recover and create a new passkey
                    </button>
                  </form>
                )}
              </>
            )}
            {status?.account && tab === "account" && (
              <>
                <p>
                  Signed in as <strong>{status.account.displayName}</strong>. Change your name using
                  the name button in the page header.
                </p>
                {!!active.length && (
                  <section>
                    <h3>Your unfinished games</h3>
                    <ul className="account-game-list">
                      {active.map((game) => (
                        <li key={game.id}>
                          <span>
                            {modeName(game.rulesetId)} ·{" "}
                            {game.phase === "waiting"
                              ? "Waiting for an opponent"
                              : (game.opponentName ?? "Playing")}
                          </span>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              close();
                              callbacks.current.onResumeGame?.(game.id);
                            }}
                          >
                            Resume
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {status.guestGames > 0 && (
                  <section>
                    <h3>Import this browser's guest games</h3>
                    <p>
                      {status.guestGames} rooms or games, including {status.guestActiveGames}{" "}
                      unfinished. Import only if they are yours. Verify your passkey first.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await ceremony("reauth");
                          await request("/api/account/guest-claim", {});
                          await changed();
                        })
                      }
                    >
                      Verify and import guest games
                    </button>
                  </section>
                )}
                <h3>Passkeys</h3>
                <ul className="account-game-list">
                  {passkeys.map((key) => (
                    <li key={key.id}>
                      <span>
                        {key.label} · {new Date(key.createdAt).toLocaleDateString()}
                      </span>
                      <button
                        type="button"
                        disabled={busy || passkeys.length <= 1}
                        onClick={() =>
                          void run(async () => {
                            await ceremony("reauth");
                            await request(
                              `/api/account/passkeys/${encodeURIComponent(key.id)}`,
                              undefined,
                              "DELETE",
                            );
                            await load();
                          })
                        }
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ceremony("reauth");
                      await ceremony("add-passkey");
                    })
                  }
                >
                  Add another passkey
                </button>
                <p>
                  {status.account.recoveryCodesRemaining} recovery codes remain. Keep a second
                  passkey on another device.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await ceremony("reauth");
                      const result = await request<{ recovery: RecoveryKit }>(
                        "/api/account/recovery-codes",
                        {},
                      );
                      setRecovery(result.recovery);
                      await load();
                    })
                  }
                >
                  Replace recovery codes
                </button>
                <div className="account-actions">
                  <p>
                    Up to 16 browser sessions are kept. Signing in beyond that limit signs out the
                    oldest session.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await endIdentity("/api/auth/logout");
                      })
                    }
                  >
                    Sign out
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await endIdentity("/api/auth/logout-all");
                      })
                    }
                  >
                    Sign out all devices
                  </button>
                </div>
                <button
                  className="button-danger"
                  type="button"
                  disabled={busy}
                  onClick={() => setDeleteConfirmation(true)}
                >
                  Delete account
                </button>
                {deleteConfirmation && (
                  <section className="account-delete" aria-label="Confirm account deletion">
                    <p>
                      This permanently removes login access and your saved history. Waiting rooms
                      close and unfinished games are resigned. Opponents retain anonymized results.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await ceremony("reauth");
                          await endIdentity("/api/account", "DELETE");
                          setDeleteConfirmation(false);
                          setRecovery(null);
                        })
                      }
                    >
                      Verify and permanently delete account
                    </button>
                    <button type="button" onClick={() => setDeleteConfirmation(false)}>
                      Keep account
                    </button>
                  </section>
                )}
              </>
            )}
            {status?.account &&
              tab === "history" &&
              (!saved ? (
                <>
                  <p>
                    Your latest 500 completed games are saved for up to 365 days. Only participating
                    accounts can read them.
                  </p>
                  <div className="account-filters">
                    <label>
                      Mode
                      <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                        <option value="">All modes</option>
                        {RULESETS.map((rule) => (
                          <option value={rule.id} key={rule.id}>
                            {rule.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Opponent
                      <select
                        value={opponentFilter}
                        onChange={(e) => setOpponentFilter(e.target.value)}
                      >
                        <option value="">All opponents</option>
                        <option value="human">Friends</option>
                        <option value="bot">Cat Bot</option>
                      </select>
                    </label>
                    <label>
                      Result
                      <select
                        value={resultFilter}
                        onChange={(e) => setResultFilter(e.target.value)}
                      >
                        <option value="">All results</option>
                        {["win", "loss", "draw"].map((result) => (
                          <option key={result} value={result}>
                            {result}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {!history.games.length && !busy && (
                    <p>No completed games match these filters yet.</p>
                  )}
                  <ul className="account-game-list">
                    {history.games.map((game) => (
                      <li key={game.id}>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const identity = preferenceEpoch.current;
                              const generation = historyEpoch.current;
                              const detail = await request<SavedGame>(
                                `/api/account/history/${game.id}`,
                              );
                              if (
                                identity !== preferenceEpoch.current ||
                                generation !== historyEpoch.current ||
                                !signedIn.current
                              )
                                return;
                              setSaved(detail);
                              setPly(0);
                            })
                          }
                        >
                          <strong>
                            {game.result} · {game.opponentName}
                          </strong>
                          <span>
                            {modeName(game.rulesetId)} ·{" "}
                            {new Date(game.finishedAt).toLocaleDateString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {history.nextCursor && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => loadHistory(history.nextCursor ?? undefined))}
                    >
                      Load more games
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setSaved(null)}>
                    Back to history
                  </button>
                  <h3>
                    {saved.players.white.displayName} — {saved.players.black.displayName}
                  </h3>
                  <p>
                    {modeName(saved.game.rulesetId)} · {saved.game.result} ·{" "}
                    {saved.game.reason.replaceAll("-", " ")}
                  </p>
                  <div className="replay-control-panel">
                    <label>
                      Replay position
                      <input
                        type="range"
                        min={0}
                        max={saved.positions.length}
                        value={ply}
                        onChange={(event) => setPly(Number(event.target.value))}
                      />
                    </label>
                    <div className="replay-controls">
                      <button
                        type="button"
                        disabled={ply === 0}
                        aria-label="Initial position"
                        onClick={() => setPly(0)}
                      >
                        First
                      </button>
                      <button
                        type="button"
                        disabled={ply === 0}
                        onClick={() => setPly((p) => p - 1)}
                      >
                        Previous
                      </button>
                      <output aria-live="polite">
                        {ply}/{saved.positions.length}
                      </output>
                      <button
                        type="button"
                        disabled={ply === saved.positions.length}
                        onClick={() => setPly((p) => p + 1)}
                      >
                        Next
                      </button>
                      <button
                        type="button"
                        disabled={ply === saved.positions.length}
                        onClick={() => setPly(saved.positions.length)}
                      >
                        Last
                      </button>
                    </div>
                  </div>
                  <ReadonlyBoard
                    orientation={saved.game.color}
                    fen={
                      ply === 0
                        ? saved.initialFen
                        : (saved.positions[ply - 1]?.fen ?? saved.initialFen)
                    }
                  />
                  <p>
                    {ply === 0
                      ? "Initial position"
                      : `${saved.positions[ply - 1]?.move.san ?? ""}${saved.positions[ply - 1]?.catEffect?.action !== "none" && saved.positions[ply - 1]?.catEffect ? ` · Cat ${saved.positions[ply - 1]?.catEffect?.action} on ${saved.positions[ply - 1]?.catEffect?.square}` : ""}`}
                  </p>
                  <ol className="account-replay-moves">
                    {saved.positions.map((position, i) => (
                      <li key={position.move.ply}>
                        <button
                          type="button"
                          aria-current={ply === i + 1 ? "step" : undefined}
                          onClick={() => setPly(i + 1)}
                        >
                          {position.move.san}
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div className="account-actions">
                    <a href={`/api/account/history/${saved.game.id}/pgn`} download>
                      Download PGN
                    </a>
                    <a href={`/api/account/history/${saved.game.id}/json`} download>
                      Download replay JSON
                    </a>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await request(
                            `/api/account/history/${saved.game.id}`,
                            undefined,
                            "DELETE",
                          );
                          setSaved(null);
                          await loadHistory();
                        })
                      }
                    >
                      Hide from my history
                    </button>
                  </div>
                  <p>
                    PGN describes cat actions in comments; other chess tools may not reproduce their
                    piece changes.
                  </p>
                </>
              ))}
          </div>
        </Modal>
      )}
    </>
  );
}
