import { z } from "zod";

export const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const idSchema = z.string().min(1);
const colorSchema = z.string().min(1);

export const pencilStrokeSchema = z.object({
  id: idSchema,
  kind: z.literal("pencil"),
  points: z.array(pointSchema).min(1),
  color: colorSchema,
  width: z.number().positive(),
});

export const eraserStrokeSchema = pencilStrokeSchema.extend({
  kind: z.literal("eraser"),
});

const boxFields = {
  id: idSchema,
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: colorSchema,
  strokeWidth: z.number().positive(),
};

export const rectStrokeSchema = z.object({ ...boxFields, kind: z.literal("rect") });
export const ellipseStrokeSchema = z.object({ ...boxFields, kind: z.literal("ellipse") });
export const lineStrokeSchema = z.object({ ...boxFields, kind: z.literal("line") });

export const strokeSchema = z.discriminatedUnion("kind", [
  pencilStrokeSchema,
  eraserStrokeSchema,
  rectStrokeSchema,
  ellipseStrokeSchema,
  lineStrokeSchema,
]);

export const peerSchema = z.object({
  id: idSchema,
  name: z.string(),
  color: colorSchema,
  x: z.number(),
  y: z.number(),
});

export const joinMessageSchema = z.object({
  type: z.literal("join"),
  boardId: z.string().uuid(),
  clientId: idSchema,
  name: z.string().min(1).max(24),
  color: colorSchema,
});

export const strokeMessageSchema = z.object({
  type: z.literal("stroke"),
  boardId: z.string().uuid(),
  stroke: strokeSchema,
});

export const deleteMessageSchema = z.object({
  type: z.literal("delete"),
  boardId: z.string().uuid(),
  strokeId: idSchema,
});

export const clearMessageSchema = z.object({
  type: z.literal("clear"),
  boardId: z.string().uuid(),
});

export const cursorMessageSchema = z.object({
  type: z.literal("cursor"),
  boardId: z.string().uuid(),
  x: z.number(),
  y: z.number(),
});

export const previewMessageSchema = z.object({
  type: z.literal("preview"),
  boardId: z.string().uuid(),
  stroke: strokeSchema.nullable(),
});

export const collabMessageSchema = z.object({
  type: z.literal("collab"),
  boardId: z.string().uuid(),
  enabled: z.boolean(),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinMessageSchema,
  strokeMessageSchema,
  deleteMessageSchema,
  clearMessageSchema,
  cursorMessageSchema,
  previewMessageSchema,
  collabMessageSchema,
]);

export const welcomeMessageSchema = z.object({
  type: z.literal("welcome"),
  strokes: z.array(strokeSchema),
  peers: z.array(peerSchema),
  owner: z.boolean(),
  collab: z.boolean(),
});

export const collabStartedMessageSchema = z.object({
  type: z.literal("collab"),
  enabled: z.boolean(),
});

export const serverCursorMessageSchema = cursorMessageSchema.extend({
  clientId: idSchema,
  name: z.string(),
  color: colorSchema,
});

export const serverPreviewMessageSchema = previewMessageSchema.extend({
  clientId: idSchema,
});

export const cursorLeftMessageSchema = z.object({
  type: z.literal("cursor-left"),
  clientId: idSchema,
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  welcomeMessageSchema,
  strokeMessageSchema,
  deleteMessageSchema,
  clearMessageSchema,
  serverCursorMessageSchema,
  serverPreviewMessageSchema,
  cursorLeftMessageSchema,
  collabStartedMessageSchema,
  errorMessageSchema,
]);

export type Stroke = z.infer<typeof strokeSchema>;
export type Peer = z.infer<typeof peerSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
