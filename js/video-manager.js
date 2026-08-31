// js/video-manager.js — Intelligent video & audio controller for The True GOAT contenders
(function() {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (!isBrowser) return;

  const VIDEO_CATALOG = {
    'abraham lincoln': 'downloads/abraham.mp4',
    'carlos alcaraz': 'downloads/alcaraz.mp4',
    'alfred hitchcock': 'downloads/alfred.mp4',
    'amitabh bachchan': 'downloads/amitabh bachan.mp4',
    'leonardo dicaprio': 'downloads/dicaprio.mp4',
    'robert de niro': 'downloads/dinro.mp4',
    'albert einstein': 'downloads/einstein.mp4',
    'elon musk': 'downloads/elon musk.mp4',
    'eminem': 'downloads/eminem.mp4',
    'marshall mathers': 'downloads/eminem.mp4',
    'roger federer': 'downloads/federer.mp4',
    'floyd mayweather': 'downloads/floyd.mp4',
    'floyd mayweather jr.': 'downloads/floyd.mp4',
    'pink floyd': 'downloads/floyd.mp4',
    'the godfather': 'downloads/godfather.mp4',
    'michael jackson': 'downloads/jackson.mp4',
    'jay-z': 'downloads/jayz.mp4',
    'jay z': 'downloads/jayz.mp4',
    'michael jordan': 'downloads/jordan.mp4',
    'kanye west': 'downloads/kanye west.mp4',
    'garry kasparov': 'downloads/kasparov.mp4',
    'john f. kennedy': 'downloads/kennedy.mp4',
    'john f kennedy': 'downloads/kennedy.mp4',
    'kobe bryant': 'downloads/kobe.mp4',
    'virat kohli': 'downloads/kohli.mp4',
    'lebron james': 'downloads/lebron.mp4',
    'lewis hamilton': 'downloads/lewis hamilton.mp4',
    'magnus carlsen': 'downloads/magnus carlsen.mp4',
    'marlon brando': 'downloads/marlon brando.mp4',
    'max verstappen': 'downloads/max verstappen.mp4',
    'lionel messi': 'downloads/messi.mp4',
    'mike tyson': 'downloads/mike tyson.mp4',
    'narendra modi': 'downloads/modi.mp4',
    'muhammad ali': 'downloads/muhammad ali.mp4',
    'rafael nadal': 'downloads/nadal.mp4',
    'jawaharlal nehru': 'downloads/nehru.mp4',
    'isaac newton': 'downloads/newton.mp4',
    'christopher nolan': 'downloads/nolan.mp4',
    'novak djokovic': 'downloads/novak.mp4',
    'pele': 'downloads/pele.mp4',
    'pelé': 'downloads/pele.mp4',
    'edson arantes do nascimento': 'downloads/pele.mp4',
    'sachin tendulkar': 'downloads/sachin tendulkar.mp4',
    'martin scorsese': 'downloads/scoresese.mp4',
    'shah rukh khan': 'downloads/shahrukh khan.mp4',
    'shahrukh khan': 'downloads/shahrukh khan.mp4',
    'jannik sinner': 'downloads/sinner.mp4',
    'steven spielberg': 'downloads/speliberg.mp4',
    'steve jobs': 'downloads/steve jobs.mp4',
    'taylor swift': 'downloads/taylor swift.mp4',
    'the dark knight': 'downloads/the dark knight.mp4',
    'tupac shakur': 'downloads/tupac.mp4',
    '2pac': 'downloads/tupac.mp4',
    'tupac': 'downloads/tupac.mp4',
    'viswanathan anand': 'downloads/vishy.mp4',
    'vishy anand': 'downloads/vishy.mp4'
  };

  const KEYWORD_MAP = [
    { match: ['messi'], video: 'downloads/messi.mp4' },
    { match: ['federer'], video: 'downloads/federer.mp4' },
    { match: ['djokovic', 'novak'], video: 'downloads/novak.mp4' },
    { match: ['nadal'], video: 'downloads/nadal.mp4' },
    { match: ['alcaraz'], video: 'downloads/alcaraz.mp4' },
    { match: ['sinner'], video: 'downloads/sinner.mp4' },
    { match: ['spielberg', 'speliberg'], video: 'downloads/speliberg.mp4' },
    { match: ['scorsese', 'scoresese'], video: 'downloads/scoresese.mp4' },
    { match: ['brando'], video: 'downloads/marlon brando.mp4' },
    { match: ['de niro', 'deniro', 'dinro'], video: 'downloads/dinro.mp4' },
    { match: ['dicaprio'], video: 'downloads/dicaprio.mp4' },
    { match: ['jordan'], video: 'downloads/jordan.mp4' },
    { match: ['lebron'], video: 'downloads/lebron.mp4' },
    { match: ['kobe'], video: 'downloads/kobe.mp4' },
    { match: ['jackson'], video: 'downloads/jackson.mp4' },
    { match: ['lincoln', 'abraham'], video: 'downloads/abraham.mp4' },
    { match: ['einstein'], video: 'downloads/einstein.mp4' },
    { match: ['newton'], video: 'downloads/newton.mp4' },
    { match: ['steve jobs', 'jobs'], video: 'downloads/steve jobs.mp4' },
    { match: ['elon musk', 'musk'], video: 'downloads/elon musk.mp4' },
    { match: ['tupac', '2pac', 'shakur'], video: 'downloads/tupac.mp4' },
    { match: ['tyson', 'mike tyson'], video: 'downloads/mike tyson.mp4' },
    { match: ['muhammad ali', 'ali'], video: 'downloads/muhammad ali.mp4' },
    { match: ['lewis hamilton', 'hamilton'], video: 'downloads/lewis hamilton.mp4' },
    { match: ['verstappen'], video: 'downloads/max verstappen.mp4' },
    { match: ['bachchan', 'bachan'], video: 'downloads/amitabh bachan.mp4' },
    { match: ['shah rukh', 'shahrukh'], video: 'downloads/shahrukh khan.mp4' },
    { match: ['tendulkar', 'sachin'], video: 'downloads/sachin tendulkar.mp4' },
    { match: ['kohli'], video: 'downloads/kohli.mp4' },
    { match: ['carlsen', 'magnus'], video: 'downloads/magnus carlsen.mp4' },
    { match: ['kasparov'], video: 'downloads/kasparov.mp4' },
    { match: ['anand', 'vishy'], video: 'downloads/vishy.mp4' },
    { match: ['nehru'], video: 'downloads/nehru.mp4' },
    { match: ['modi'], video: 'downloads/modi.mp4' },
    { match: ['kennedy', 'jfk'], video: 'downloads/kennedy.mp4' },
    { match: ['hitchcock'], video: 'downloads/alfred.mp4' },
    { match: ['nolan'], video: 'downloads/nolan.mp4' },
    { match: ['taylor swift', 'swift'], video: 'downloads/taylor swift.mp4' },
    { match: ['kanye', 'kanye west'], video: 'downloads/kanye west.mp4' },
    { match: ['eminem', 'mathers'], video: 'downloads/eminem.mp4' },
    { match: ['jay-z', 'jayz'], video: 'downloads/jayz.mp4' },
    { match: ['dark knight'], video: 'downloads/the dark knight.mp4' },
    { match: ['godfather'], video: 'downloads/godfather.mp4' },
    { match: ['pele', 'pelé'], video: 'downloads/pele.mp4' }
  ];

  function normalize(str) {
    if (!str) return '';
    return str.toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  function getVideo(name, slug) {
    const rawName = (name || '').trim();
    const rawSlug = (slug || '').trim();
    if (!rawName && !rawSlug) return null;

    const lowerName = rawName.toLowerCase();
    if (VIDEO_CATALOG[lowerName]) return VIDEO_CATALOG[lowerName];

    const normName = normalize(rawName);
    const normSlug = normalize(rawSlug);

    for (const [k, v] of Object.entries(VIDEO_CATALOG)) {
      const nk = normalize(k);
      if (nk === normName || nk === normSlug) return v;
    }

    for (const item of KEYWORD_MAP) {
      for (const m of item.match) {
        const nm = normalize(m);
        if (normName.includes(nm) || normSlug.includes(nm)) {
          return item.video;
        }
      }
    }
    return null;
  }

  window.PersonMedia = { getVideo };
})();
