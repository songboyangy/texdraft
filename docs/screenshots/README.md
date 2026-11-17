# Screenshots

These images are referenced from the README.

| File | Used in | Shows |
|---|---|---|
| `agent-en.png` | `README.md` | English UI. The built-in agent was asked to turn Table 1 into a booktabs table. It edited `main.tex`, compiled and checked the PDF. The change summary with Undo is at the bottom of the chat. |
| `agent-zh.png` | `README.zh-CN.md` | The same scenario with the Chinese UI and a Chinese paper compiled with XeLaTeX (`ctexart`). |

How they were made:

- **Paper**: a fictional sample by "Anonymous Authors". Every citation is a real paper.
- **Agent**: a real run with `deepseek-chat`.
- **Capture**: headless Chrome at 1800×1100 with device scale factor 2.
- **Processing**: resized to 2400 px wide and quantized to 256 colours.
- **Privacy**: no personal data.
- **Rename**: after the rename to TeXdraft, the model chip (bottom right) was re-rendered with the same font (Inter 400, 12px) and pasted in; nothing else in the images was edited.

When the UI changes noticeably, retake them with the same scenario so that the two languages stay consistent.
