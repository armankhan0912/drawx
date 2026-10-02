"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("Guest");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("drawx-name");
    if (saved) setName(saved);
  }, []);

  async function createBoard() {
    const trimmed = name.trim().slice(0, 24) || "Guest";
    localStorage.setItem("drawx-name", trimmed);
    setPending(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerId: clientId() }),
      });
      if (!response.ok) throw new Error("create failed");
      const body = (await response.json()) as { id: string };
      router.push(`/board/${body.id}`);
    } catch {
      setError("The board server is not running.");
      setPending(false);
    }
  }

  return (
    <main className="flex h-dvh items-center justify-center bg-[#111111] px-6 text-zinc-100">
      <div className="w-full max-w-md rounded-2xl bg-zinc-900 p-8 shadow-lg ring-1 ring-white/10">
        <h1 className="text-3xl font-semibold">Drawx</h1>
        <p className="mt-2 text-zinc-400">Start a private canvas. Invite someone when you want to.</p>
        <label className="mt-6 block text-sm text-zinc-300" htmlFor="name">
          Your name
        </label>
        <input
          id="name"
          value={name}
          maxLength={24}
          onChange={(event) => setName(event.target.value)}
          className="mt-2 w-full rounded-lg bg-zinc-800 px-3 py-2 outline-none ring-1 ring-white/10 focus:ring-white/30"
        />
        {error ? <p className="mt-3 text-sm text-rose-300">{error}</p> : null}
        <button
          type="button"
          onClick={createBoard}
          disabled={pending}
          className="mt-6 w-full rounded-lg bg-white px-4 py-2 font-medium text-zinc-950 disabled:opacity-60"
        >
          {pending ? "Creating…" : "New board"}
        </button>
      </div>
    </main>
  );
}

function clientId() {
  let id = localStorage.getItem("drawx-client");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("drawx-client", id);
  }
  return id;
}
