interface CallRecordingPlayerProps {
  readonly sessionId: string;
  readonly label: string;
  readonly unsupported: string;
}

export function CallRecordingPlayer({
  sessionId,
  label,
  unsupported,
}: CallRecordingPlayerProps) {
  return (
    <div className="call-recording-player">
      <strong>{label}</strong>
      <audio
        aria-label={label}
        controls
        preload="metadata"
        src={`/api/voice/sessions/${encodeURIComponent(sessionId)}/recording`}
      >
        {unsupported}
      </audio>
    </div>
  );
}
