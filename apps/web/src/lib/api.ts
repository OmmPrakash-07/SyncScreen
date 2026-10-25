
const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

export interface RoomResponse {
  roomId: string;
  userId: string;
  username: string;
  role: "host" | "moderator" | "participant";
  joinUrl?: string;
  error?: string;
}

async function request<T>(
  path: string,
  body: unknown
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as T;

  if (!response.ok) {
    throw new Error(
      (data as { detail?: string; error?: string }).detail ??
        (data as { error?: string }).error ??
        "Request failed"
    );
  }

  if ((data as { error?: string }).error) {
    throw new Error((data as { error: string }).error);
  }

  return data;
}

export function createRoom(username: string) {
  return request<RoomResponse>("/api/rooms", { username });
}

export function joinRoom(roomId: string, username: string) {
  return request<RoomResponse>(
    `/api/rooms/${encodeURIComponent(roomId)}/join`,
    { username }
  );
}
