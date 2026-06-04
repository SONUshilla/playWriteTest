const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const mp4Input = path.join(__dirname, 'assets', 'face.mp4');
const y4mOutput = path.join(__dirname, 'assets', 'face-test.y4m');

console.log('===================================================');
console.log('🎥 Generating lightweight raw Y4M for native Chrome capture...');

if (fs.existsSync(y4mOutput)) {
  console.log(`✅ face-test.y4m already exists. Ready to go.`);
  process.exit(0);
}

// Convert to raw YUV4MPEG2 (y4m). No crf or preset needed for raw video.
ffmpeg(mp4Input)
  .outputOptions([
    '-vf scale=1920:1080',  // CHANGED: Forces 720p resolution
    '-t 8',                // 8 second loop
    '-an',                 // Strip audio
    '-pix_fmt yuv420p'     // Required color space for Chrome
  ])
  .toFormat('yuv4mpegpipe')
  .save(y4mOutput)
  .on('end', () => {
    console.log(`🎉 Done! face-test.y4m created.`);
  })
  .on('error', (err) => console.error('❌ Conversion error:', err.message));