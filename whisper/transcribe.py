
from faster_whisper import WhisperModel

print("Memuat model Whisper Tiny...")

model = WhisperModel(
    "tiny",
    device="cpu",
    compute_type="int8"
)

print("Mulai transkripsi...")

segments, info = model.transcribe(
    "videos/sample.mp4",
    language="id",
    vad_filter=True
)

segments = list(segments)

# Simpan hasil subtitle SRT
with open("output.srt", "w", encoding="utf-8") as f:
    for i, segment in enumerate(segments, start=1):
        start = segment.start
        end = segment.end

        def timestamp(seconds):
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            secs = int(seconds % 60)
            milliseconds = int((seconds % 1) * 1000)

            return (
                f"{hours:02}:{minutes:02}:"
                f"{secs:02},{milliseconds:03}"
            )

        f.write(f"{i}\n")
        f.write(f"{timestamp(start)} --> {timestamp(end)}\n")
        f.write(f"{segment.text.strip()}\n\n")

print("Transkripsi selesai!")
print("File subtitle: output.srt")
