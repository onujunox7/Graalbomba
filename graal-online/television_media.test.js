'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceUrl, publicAddress, readSegments, encodeArgs } = require('./television_media');

test('links de cinco plataformas são normalizados sem aceitar URLs arbitrárias', () => {
  assert.equal(sourceUrl('https://youtu.be/jNQXAC9IVRw?si=abc').url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  for (const [url, provider] of [
    ['https://twitch.tv/monstercat', 'twitch'], ['https://www.twitch.tv/videos/12345', 'twitch'],
    ['https://clips.twitch.tv/SomeClip', 'twitch'], ['https://kick.com/channel', 'kick'],
    ['https://vimeo.com/12345', 'vimeo'], ['https://www.dailymotion.com/video/x12345', 'dailymotion']
  ]) assert.equal(sourceUrl(url).provider, provider);
  for (const url of ['file:///etc/passwd', 'http://localhost/1', 'https://127.0.0.1',
    'https://youtube.com.evil.com/watch?v=jNQXAC9IVRw', 'https://user:pass@kick.com/channel',
    'https://kick.com:444/channel', 'https://kick.com/api/v1/video', 'https://youtube.com/playlist?list=abc']) {
    assert.throws(() => sourceUrl(url));
  }
});

test('origens privadas e locais são recusadas', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '100.64.1.1', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.equal(publicAddress(ip), false);
  assert(publicAddress('8.8.8.8'));
  assert(publicAddress('2606:4700:4700::1111'));
});

test('encoder usa clipes Theora com áudio, duração fixa e lista limitada', () => {
  const args = encodeArgs('https://video.googlevideo.com/source', '/tmp/tv-test');
  assert(args.includes('libtheora'));
  assert(args.includes('libvorbis'));
  assert.equal(args[args.indexOf('-segment_time') + 1], '4');
  assert.equal(args[args.indexOf('-segment_list_size') + 1], '24');
  assert(!args[args.indexOf('-protocol_whitelist') + 1].includes('file'));
  assert.deepEqual(readSegments('/nonexistent-television-folder'), []);
});
