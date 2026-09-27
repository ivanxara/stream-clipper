// Corre no "mundo" da página do YouTube (não no da extensão), só para ler o player:
// o content script não tem acesso ao objeto #movie_player.
(() => {
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (ev.source !== window || !m || m.__scYT !== 'q') return;
    const r = { __scYT: 'a', id: m.id, ok: false };
    try {
      const p = document.getElementById('movie_player');
      const vd = p.getVideoData();
      const pr = p.getPlayerResponse?.();
      r.ok = true;
      r.vid = vd.video_id;
      const broadcast = pr?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
      r.isLive = broadcast?.endTimestamp ? false
        : (broadcast?.isLiveNow ?? !!(vd.isLive || pr?.videoDetails?.isLive));
      r.t = p.getCurrentTime();   // tempo do média: em lives = nº do segmento × duração do segmento
      r.ad = p.classList.contains('ad-showing');
    } catch (e) {
      r.error = String(e?.message || e);
    }
    window.postMessage(r, location.origin);
  });
})();
