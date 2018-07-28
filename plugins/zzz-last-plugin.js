// This code is run after all plugins have initialized

//WDH
BOOMR.init({
  beacon_url: "https://data.leadwire.io/rum/"+BOOMR.window.BOOMR_appuuid
});


BOOMR.t_end = new Date().getTime();
