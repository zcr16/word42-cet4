/* Shared English speech lifecycle for writing and vocabulary; no network calls. */
(function (root, factory) {
  const tools = factory();
  if (typeof module === 'object' && module.exports) module.exports = tools;
  else { root.Word42SpeechTools = tools; root.Word42Audio = tools.createController(root); }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Preserve every character, including inter-sentence whitespace. Protect
  // decimal points, initials and common abbreviations before finding a boundary.
  function splitSentences(value) {
    const text = String(value ?? '');
    if (!text) return [];
    const result = [], titles = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|fig|no|approx|dept|inc|ltd|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (!/[.!?]/.test(text[i])) continue;
      if (text[i] === '.') {
        if (/\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue;
        if (/[A-Za-z]/.test(text[i + 1] || '')) continue;
        const token = (text.slice(0, i).match(/([A-Za-z][A-Za-z.]*)$/) || [])[1] || '';
        if (titles.test(token) || /^(?:e\.g|i\.e)$/i.test(token) || /^[A-Z]$/.test(token)) continue;
        if (/^(?:[A-Za-z]\.)+[A-Za-z]$/.test(token) || /^(?:a|p)\.m$/i.test(token)) {
          const next = text.slice(i + 1).trimStart();
          if (next && !/^(?:I|We|You|They|He|She|It|This|That|These|Those|The|A|An|However|Therefore|Finally|Meanwhile)\b/.test(next)) continue;
        }
        if (/^etc$/i.test(token) && /^\s+[a-z]/.test(text.slice(i + 1))) continue;
      }
      let end = i + 1;
      while (end < text.length && /[.!?"'”’\])}]/.test(text[end])) end++;
      if (end < text.length && !/\s/.test(text[end])) continue;
      while (end < text.length && /\s/.test(text[end])) end++;
      result.push(text.slice(start, end));start = end;i = end - 1;
    }
    if (start < text.length) result.push(text.slice(start));
    return result;
  }

  function createController(env) {
    let job = null, sequence = 0;
    // Only fixed lifecycle labels enter diagnostics: never text, notes, URLs,
    // request IDs or the raw platform error message.
    const diagnostic = (kind, value) => { try { env.console?.info?.('[Word42Speech] ' + kind + '=' + value); } catch (_) {} };
    const later = (fn, ms) => env.setTimeout(fn, ms), clear = id => env.clearTimeout(id);
    const current = (owner, id) => job === owner && owner.requestId === id;
    const notify = (owner, status, message = '') => owner.onChange({ status, message, id: owner.items[owner.index]?.id, index: owner.index, total: owner.items.length });
    function cleanup(owner) {
      clear(owner.timer);clear(owner.voiceTimer);
      if (owner.voiceListener) env.speechSynthesis?.removeEventListener?.('voiceschanged', owner.voiceListener);
      owner.voiceListener = null;
    }
    function cancelBackend(owner) {
      try { if (owner.mode === 'native') env.Word42Speech?.stop(); else if (owner.mode === 'browser') env.speechSynthesis?.cancel(); } catch (_) {}
    }
    function stop() {
      const previous = job;job = null;
      if (!previous) return;
      cleanup(previous);cancelBackend(previous);notify(previous, 'stop');
    }
    function fail(owner, id, message, code = 'speech_error') {
      if (!current(owner, id)) return;
      diagnostic('error', code);
      job = null;cleanup(owner);cancelBackend(owner);notify(owner, 'error', message || '英语朗读暂不可用，请检查系统英语语音。');
    }
    function signal(id, status, message) {
      const owner = job;if (!owner || owner.requestId !== id) return;
      if (status === 'preparing' && owner.started) return;
      if (['preparing','start','end','error'].includes(status)) diagnostic('signal', status);
      if (status === 'preparing') {
        if (!owner.preparationWaiting) {
          owner.preparationWaiting = true;clear(owner.timer);
          owner.timer = later(() => fail(owner, id, '英语声音资源准备超时，请检查网络后重试。', 'preparation_timeout'), 300000);
        }
        notify(owner, 'preparing', typeof message === 'string' && message ? message.slice(0, 300) : '正在准备英语声音资源，首次使用请稍候。');
      } else if (status === 'start') {
        owner.started = true;
        clear(owner.timer);
        owner.timer = later(() => fail(owner, id, '朗读没有正常结束，请点句子重试。', 'completion_timeout'), Math.min(90000, Math.max(15000, owner.items[owner.index].text.length * 150 / owner.rate + 10000)));
        notify(owner, 'start');
      } else if (status === 'end') {
        if (message === 'stopped') { stop();return; }
        cleanup(owner);notify(owner, 'end');
        // A callback can itself stop or replace playback.
        if (!current(owner, id)) return;
        owner.index++;
        if (owner.index >= owner.items.length) { job = null;notify(owner, 'complete'); }
        else begin(owner);
      } else if (status === 'error') fail(owner, id, typeof message === 'string' ? message.slice(0, 300) : '英语朗读失败，请重试。', owner.mode === 'native' ? 'native_error' : 'browser_error');
    }
    env.__word42SpeechEvent = signal;
    function browserSpeak(owner, id) {
      const synth = env.speechSynthesis;
      owner.mode = 'browser';diagnostic('mode', 'browser');
      if (!synth || typeof env.SpeechSynthesisUtterance !== 'function') { fail(owner, id, '当前设备没有可用的英语朗读服务。', 'browser_unavailable');return; }
      const useVoice = () => {
        if (!current(owner, id)) return true;
        let voices;
        try { voices = synth.getVoices(); } catch (_) { fail(owner, id, '无法读取设备语音，请检查系统语音设置。', 'voice_list_failed');return true; }
        const english = voices.filter(voice => /^en(?:[-_]|$)/i.test(voice.lang));
        const voice = english.find(v => /^en[-_]US$/i.test(v.lang)) || english[0];
        if (!voice) return false;
        if (owner.voiceListener) synth.removeEventListener?.('voiceschanged', owner.voiceListener);
        owner.voiceListener = null;clear(owner.voiceTimer);
        const utterance = new env.SpeechSynthesisUtterance(owner.items[owner.index].text.trim());
        owner.utterance = utterance;utterance.lang = voice.lang;utterance.voice = voice;utterance.rate = owner.rate;
        utterance.onstart = () => signal(id, 'start');utterance.onend = () => signal(id, 'end');
        utterance.onerror = () => signal(id, 'error', '英语朗读失败，请检查设备英语语音后重试。');
        try { synth.speak(utterance); } catch (_) { fail(owner, id, '英语朗读暂不可用，请重试。', 'browser_speak_failed'); }
        return true;
      };
      if (useVoice()) return;
      owner.voiceListener = useVoice;synth.addEventListener?.('voiceschanged', useVoice);
      owner.voiceTimer = later(() => { if (current(owner, id) && !useVoice()) fail(owner, id, '设备未提供英语声音，请先在系统语音设置中添加英语语音。', 'english_voice_missing'); }, 1500);
    }
    function begin(owner) {
      if (job !== owner) return;
      const id = 'word42-' + Date.now().toString(36) + '-' + (++sequence);owner.requestId = id;
      owner.started = false;owner.preparationWaiting = false;
      notify(owner, 'loading');if (!current(owner, id)) return;
      owner.timer = later(() => fail(owner, id, '朗读启动超时，请检查英语语音服务后重试。', 'start_timeout'), 12000);
      const bridge = env.Word42Speech;
      if (bridge && typeof bridge.speak === 'function' && typeof bridge.stop === 'function') {
        owner.mode = 'native';diagnostic('mode', 'native');
        try { bridge.speak(id, owner.items[owner.index].text.trim(), owner.rate); } catch (_) { fail(owner, id, '手机英语朗读服务暂不可用，请重试。', 'native_bridge_failed'); }
      } else browserSpeak(owner, id);
    }
    function play(items, options = {}) {
      stop();
      const valid = items.filter(item => item && typeof item.text === 'string' && item.text.trim()).map(item => ({ id: item.id, text: item.text }));
      if (!valid.length) return;
      job = { items: valid, index: 0, requestId: '', rate: options.rate === 0.75 ? 0.75 : 1, onChange: typeof options.onChange === 'function' ? options.onChange : () => {}, mode: '', timer: null, voiceTimer: null };
      begin(job);
    }
    env.addEventListener?.('pagehide', stop);
    env.document?.addEventListener?.('visibilitychange', () => { if (env.document.visibilityState === 'hidden') stop(); });
    return { play, stop, isActive: () => !!job };
  }
  return { splitSentences, createController };
});
