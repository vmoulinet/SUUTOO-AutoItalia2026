SUUTOO video converter
======================

Converts any video to the format the SUUTOO screens need:
H.264, 720x1280 portrait (black bars if the source has another shape), 30 fps constant,
AAC audio, a keyframe every second, "faststart", and a size under 140 MB.
The original file is never touched: the result is saved next to it as <name>-suutoo.mp4.

WINDOWS
  1. Unzip this folder.
  2. Double-click convert-windows.bat, choose your video (or drop the video file on the .bat).
  3. If Windows says "Windows protected your PC": More info > Run anyway.

MAC
  1. Unzip this folder.
  2. Double-click convert-mac.command, choose your video (or drop the video file on it).
  3. The first time, macOS may refuse to open it: right-click the file > Open > Open.
     If that does not work, open Terminal and run:  bash convert-mac.command

FIRST RUN
  ffmpeg does the work. If it is not installed on your computer, the tool downloads it once
  (about 100 MB, needs internet) and keeps it for next time.
  Windows: %LOCALAPPDATA%\SUUTOO-converter     Mac: ~/Library/Application Support/SUUTOO-converter
  (On a Mac you can also install it yourself: brew install ffmpeg)

THEN
  Import the converted file in the SUUTOO control panel, Library tab. The panel checks it and
  tells you if anything is still wrong.
