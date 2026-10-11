"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { createSession, logUpload, type Profile } from "@/lib/api";
import { CATEGORIES, MAX_BYTES, MAX_DESC_LEN, MAX_NAME_LEN, MAX_RIG_LEN, type Category } from "@/lib/constants";
import { formatBytes, isVideoFile } from "@/lib/format";
import { loadProfile, saveProfile } from "@/lib/storage";
import { uploadToSession } from "@/lib/uploader";

type Screen = "login" | "categories" | "upload";
type ItemStatus = "queued" | "uploading" | "logging" | "done" | "error";

interface Item {
  id: string;
  file: File;
  status: ItemStatus;
  progress: number;
  error?: string;
  /** Set once the bytes are safely in Drive, so a retry only has to log. */
  driveId?: string;
  /** Rejected before upload (too big / not a video): can't be retried. */
  invalid?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

export default function FoApp() {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [screen, setScreen] = useState<Screen>("login");
  const [category, setCategory] = useState<Category | null>(null);

  useEffect(() => {
    const saved = loadProfile();
    if (saved) {
      setProfile(saved);
      setScreen("categories");
    }
    setReady(true);
  }, []);

  const [busy, setBusy] = useState(false);

  if (!ready) return <main className="app" aria-busy="true" />;

  return (
    <main className="app">
      {profile && screen !== "login" && (
        <div className="who">
          <div>
            <strong>{profile.name}</strong>
            Rig IC: {profile.rigIc}
          </div>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              setCategory(null);
              setScreen("login");
            }}
          >
            Change
          </button>
        </div>
      )}

      {screen === "login" && (
        <LoginScreen
          initial={profile}
          onSave={(p) => {
            saveProfile(p);
            setProfile(p);
            setScreen("categories");
          }}
          onCancel={profile ? () => setScreen("categories") : undefined}
        />
      )}

      {screen === "categories" && profile && (
        <CategoryScreen
          onPick={(c) => {
            setCategory(c);
            setScreen("upload");
          }}
        />
      )}

      {screen === "upload" && profile && category && (
        <UploadScreen
          key={category}
          profile={profile}
          category={category}
          busy={busy}
          setBusy={setBusy}
          onBack={() => {
            setCategory(null);
            setScreen("categories");
          }}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Screen 1: who are you                                                */
/* ------------------------------------------------------------------ */

function LoginScreen({
  initial,
  onSave,
  onCancel,
}: {
  initial: Profile | null;
  onSave: (p: Profile) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [rigIc, setRigIc] = useState(initial?.rigIc ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    const r = rigIc.trim();
    if (!n) return setError("Please enter your name.");
    if (!r) return setError("Please enter the Rig IC number.");
    onSave({ name: n, rigIc: r, code: code.trim() });
  }

  return (
    <form onSubmit={submit} noValidate>
      <h1>FO Video Upload</h1>
      <p className="muted">Enter your details once. They stay saved on this phone.</p>

      <label className="field">
        Your name
        <input
          type="text"
          value={name}
          maxLength={MAX_NAME_LEN}
          autoComplete="name"
          autoCapitalize="words"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="field">
        Rig IC number
        <input
          type="text"
          value={rigIc}
          maxLength={MAX_RIG_LEN}
          autoCapitalize="characters"
          autoComplete="off"
          onChange={(e) => setRigIc(e.target.value)}
        />
      </label>

      <label className="field">
        Access code
        <span className="hint">Shared code from your team lead</span>
        <input
          type="password"
          value={code}
          autoComplete="off"
          autoCapitalize="none"
          onChange={(e) => setCode(e.target.value)}
        />
      </label>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <div className="stack">
        <button type="submit" className="btn primary">
          Continue
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Screen 2: what are you uploading                                     */
/* ------------------------------------------------------------------ */

function CategoryScreen({ onPick }: { onPick: (c: Category) => void }) {
  return (
    <div>
      <h1>What are you uploading?</h1>
      <p className="muted">Pick one to continue.</p>
      <div className="stack">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className={`btn category${c === "Rig Issue" ? " issue" : ""}`}
            onClick={() => onPick(c)}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screen 3: pick videos and upload                                     */
/* ------------------------------------------------------------------ */

function UploadScreen({
  profile,
  category,
  busy,
  setBusy,
  onBack,
}: {
  profile: Profile;
  category: Category;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onBack: () => void;
}) {
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<Item[]>([]);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const busyRef = useRef(false);
  const counter = useRef(0);

  // Warn before the page is closed or reloaded mid-upload.
  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [busy]);

  const patch = useCallback((id: string, changes: Partial<Item>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...changes } : i)));
  }, []);

  function onFilesChosen(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = ""; // lets the same file be picked again later
    if (chosen.length === 0) return;

    setItems((prev) => {
      const next = [...prev];
      for (const file of chosen) {
        const duplicate = next.some(
          (i) =>
            i.file.name === file.name &&
            i.file.size === file.size &&
            i.file.lastModified === file.lastModified,
        );
        if (duplicate) continue;

        counter.current += 1;
        const base: Item = {
          id: `f${counter.current}`,
          file,
          status: "queued",
          progress: 0,
        };
        if (!isVideoFile(file)) {
          next.push({ ...base, status: "error", invalid: true, error: "This isn’t a video file." });
        } else if (file.size === 0) {
          next.push({ ...base, status: "error", invalid: true, error: "This file is empty." });
        } else if (file.size > MAX_BYTES) {
          next.push({ ...base, status: "error", invalid: true, error: "Larger than the 5 GB limit." });
        } else {
          next.push(base);
        }
      }
      return next;
    });
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function processItem(item: Item) {
    try {
      let driveId = item.driveId;

      if (!driveId) {
        patch(item.id, { status: "uploading", progress: 0, error: undefined });
        const session = await createSession(profile, category, item.file);

        let lastPct = -1;
        const result = await uploadToSession({
          file: item.file,
          sessionUrl: session.uploadUrl,
          onProgress: (loaded, total) => {
            const pct = Math.min(99, Math.floor((loaded / total) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              patch(item.id, { progress: pct });
            }
          },
        });
        driveId = result.id;
        patch(item.id, { driveId });
      }

      patch(item.id, { status: "logging", progress: 100, error: undefined });
      await logUpload(profile, category, description.trim(), driveId);
      patch(item.id, { status: "done", progress: 100 });
    } catch (err) {
      patch(item.id, { status: "error", error: errorMessage(err) });
    }
  }

  async function runUploads(onlyId?: string) {
    if (busyRef.current) return;
    const queue = itemsRef.current.filter(
      (i) => !i.invalid && i.status !== "done" && (!onlyId || i.id === onlyId),
    );
    if (queue.length === 0) return;

    busyRef.current = true;
    setBusy(true);

    // Keep the screen awake so the phone doesn't pause the upload.
    let wakeLock: WakeLockSentinel | null = null;
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // not supported or denied — carry on
    }

    try {
      for (const queued of queue) {
        const latest = itemsRef.current.find((i) => i.id === queued.id);
        if (latest) await processItem(latest); // one file at a time
      }
    } finally {
      try {
        await wakeLock?.release();
      } catch {
        // ignore
      }
      busyRef.current = false;
      setBusy(false);
    }
  }

  const pending = items.filter((i) => !i.invalid && i.status !== "done");
  const doneCount = items.filter((i) => i.status === "done").length;
  const allDone = items.length > 0 && pending.length === 0 && doneCount > 0;
  const hasFiles = items.length > 0;

  return (
    <div>
      <button type="button" className="link" onClick={onBack} disabled={busy}>
        ← Back
      </button>
      <h1>{category}</h1>

      <label className="field">
        Description <span className="hint">Optional — applies to every video in this batch</span>
        <textarea
          value={description}
          maxLength={MAX_DESC_LEN}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label className={`picker${busy ? " disabled" : ""}`}>
        <input type="file" accept="video/*" multiple disabled={busy} onChange={onFilesChosen} />
        <span className="btn" role="button" tabIndex={-1}>
          {hasFiles ? "＋ Add more videos" : "Choose or record videos"}
        </span>
      </label>

      {(hasFiles || busy) && (
        <div className={`banner${busy ? " active" : ""}`} role="status">
          ⚠️ Keep this page open while uploading. Don’t switch apps or lock your phone.
        </div>
      )}

      {hasFiles && (
        <ul className="files">
          {items.map((item) => (
            <li key={item.id} className={`file ${item.status === "done" ? "done" : ""} ${item.status === "error" ? "error" : ""}`}>
              <div className="file-head">
                <span className="file-name">{item.file.name}</span>
                <span className="file-size">{formatBytes(item.file.size)}</span>
              </div>

              <div
                className="bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.progress}
              >
                <div style={{ width: `${item.progress}%` }} />
              </div>

              <div className="file-foot">
                <span>
                  {item.status === "queued" && "Ready to upload"}
                  {item.status === "uploading" && `Uploading… ${item.progress}%`}
                  {item.status === "logging" && "Saving to log…"}
                  {item.status === "done" && <span className="ok-text">Uploaded ✓</span>}
                  {item.status === "error" && <span className="error-text">Failed</span>}
                </span>
              </div>

              {item.status === "error" && item.error && <p className="error-text">{item.error}</p>}

              {!busy && (item.status === "queued" || item.status === "error") && (
                <div className="file-actions">
                  {item.status === "error" && !item.invalid && (
                    <button type="button" className="btn small" onClick={() => void runUploads(item.id)}>
                      Retry
                    </button>
                  )}
                  <button type="button" className="btn small" onClick={() => removeItem(item.id)}>
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {allDone ? (
        <>
          <div className="success">All videos uploaded ✓</div>
          <div className="stack">
            <button
              type="button"
              className="btn primary"
              onClick={() => setItems([])}
            >
              Upload more in {category}
            </button>
            <button type="button" className="btn" onClick={onBack}>
              Pick another category
            </button>
          </div>
        </>
      ) : (
        hasFiles && (
          <button
            type="button"
            className="btn primary"
            disabled={busy || pending.length === 0}
            onClick={() => void runUploads()}
          >
            {busy
              ? "Uploading…"
              : `Upload ${pending.length} video${pending.length === 1 ? "" : "s"}`}
          </button>
        )
      )}
    </div>
  );
}
