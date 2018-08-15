// This code is run after all plugins have initialized

//WDH
BOOMR.init({
  beacon_url: "https://"+BOOMR.window.BOOMR_apmServer+"/"+BOOMR.window.BOOMR_appuuid+"/rum"
});


BOOMR.t_end = new Date().getTime();
