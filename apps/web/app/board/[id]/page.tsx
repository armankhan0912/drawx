"use client";

import { Board } from "@/components/Board";
import { useParams } from "next/navigation";

export default function BoardPage() {
  const params = useParams();
  const boardId = typeof params.id === "string" ? params.id : "";
  if (!boardId) return null;
  return <Board boardId={boardId} />;
}
