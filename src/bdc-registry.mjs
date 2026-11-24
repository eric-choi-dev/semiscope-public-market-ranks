// SEC 814-series registrants from the June 2026 Business Development Company Report.
// A normalized registrant name or an EDGAR issuer alias of the same CIK is required.
export const BDC_REGISTRY={
  "asOf": "2026-06-01",
  "tickerCrosswalkAsOf": "2026-11-20",
  "retrievedOn": "2026-11-21",
  "registrants": 212,
  "issuerKeys": 214,
  "report": "https://www.sec.gov/files/investment/data/other/business-development-company-report/business-development-company-2026.csv",
  "tickerSource": "https://www.sec.gov/files/company_tickers_exchange.json",
  "reportSha256": "e90392f2182482392d8145a3fdceeb74f3c4fc8c9d46bee671df5ac113161e51",
  "tickerSha256": "9551d90d1c328044ef12c8db2191cde43aa4806b331f4ec5c0309b417289eeaa"
};
const names=new Set([
  "26northbdcinc","5clendingpartnerscorp","abprivatecreditinvestorscorp","abprivatelendingfund",
  "advancedflowercapitalinc","aglprivatecreditincomefund","alliedcapitalfinancialcorp","altmorebdcinc",
  "americancapitalincomeltd","ameritranscapitalcorp","andalusiancreditcompanyllc","antaresprivatecreditfund",
  "antaresstrategiccreditfund","antaresstrategiccreditfundiillc","apollodebtsolutionsbdc","apsbdcllc",
  "arescoreinfrastructurefund","aresstrategicincomefund","audaxcreditbdcinc","audaxprivatecreditfundllc",
  "axarcreditopportunityfundinc","baincapitalprivatecredit","baincapitalspecialtyfinanceinc","baringsbdcinc",
  "baringscapitalinvestmentcorp","bcpartnerslendingcorp","bcpinvestmentcorp","benefitstreetpartnersbdcinc",
  "berthelgrowthtrustii","berthelsbicllc","bipventuresevergreenbdc","blackrockdirectlendingcorp",
  "blackrockprivatecreditfund","blackrocktcpcapitalcorp","blackstoneprivatecreditfund","blackstoneprivaterealestatecreditandincomefund",
  "blackstonesecuredlendingfund","blueowlcapitalcorp","blueowlcapitalcorpii","blueowlcreditincomecorp",
  "blueowltechnologyfinancecorp","blueowltechnologyincomecorp","brightwoodcapitalcorpi","butterflyventuresllc",
  "capitalsouthpartnersfundiilp","capitalsouthpartnerssbicfundiiilp","capitalsouthwestcorp","capqbdc",
  "capqbdcinc","carlylecreditsolutionsinc","carlylesecuredlendinginc","ccsixportfolioholdingsllc",
  "championinvestmentsinc","chicagoatlanticbdcinc","cioninvestmentcorp","commonwealthcreditpartnersbdciinc",
  "corporatecapitaltrustiia","crescentcapitalbdcinc","crescentprivatecreditincomecorp","crescentreincorporationsubinc",
  "crestlinelendingsolutionsllc","eaglepointtrinityseniorsecuredlendingco","edvestentrepreneurialgrowthfundinc","elkassociatesfundingcorp",
  "equusinvestmentsinc","equustotalreturninc","evercoreinvestmentcorp","fidelityprivatecreditcollc",
  "fidelityprivatecreditfund","fidusinvestmentcorp","fidusmezzaninecapitallp","firsteagleprivatecreditfund",
  "firsthandtechnologyvaluefundinc","fortressprivatelendingfund","franklinbspcapitalcorp","fskkrcapitalcorp",
  "gladstoneinvestmentcorpde","gladstoneinvestmentcorporationde","goldmansachsbdcinc","goldmansachsprivatemiddlemarketcreditiillc",
  "golubcapitalbdc4inc","golubcapitalbdcinc","golubcapitaldirectlendingcorp","golubcapitaldirectlendingunleveredcorp",
  "golubcapitalprivatecreditfund","guggenheiminvestmentsprivatecreditfund","hancockparkcorporateincomeinc","herculescapitalinc",
  "herculesenergytechnologyandresourcemanagementinc","hillcapitalcorp","horizontechnologyfinancecorp","hpscorporatecapitalsolutionsbdc",
  "hpscorporatecapitalsolutionsfund","hpscorporatelendingfund","investcorpcreditmanagementbdcinc","jacksonadvisorygroupinc",
  "jefferiescreditpartnersbdcinc","jefferiesprivatecreditbdcinc","kayneandersonbdcinc","kaynedl2021inc",
  "kennedylewiscapitalco","kkrbdcinc","kkrenhancedusdirectlendingfundlinc","kkrfsincometrustselect",
  "lafayettesquareusainc","lgamprivatecreditllc","lordabbettprivatecreditfund","lordabbettprivatecreditfunds",
  "mainstreetcapitalcorp","manulifeprivatecreditfund","maxgoldwellbdcllc","mbloombusinessdevelopmentcollc",
  "mevcdeltalifesciencesfundiinc","mgi2inc","midcapapolloinstitutionalprivatelending","midcapfinancialinvestmentcorp",
  "monroecapitalenhancedcorporatelendingfund","monroecapitalincomepluscorp","morganstanleydirectlendingfund","mscincomefundinc",
  "msdinvestmentcorp","muzinichbdcinc","muzinichcapitalinc","muzinichcorporatelendingincomefundinc",
  "neostellarcapitalcorp","newmountainfinancecorp","newmountainguardianivbdcllc","newmountainguardianivincomefundllc",
  "newmountainprivatecreditfund","nexpointcapitalinc","nmfslfiinc","northhavenprivateincomefundallc",
  "northhavenprivateincomefundllc","nuveenchurchilldirectlendingcorp","nuveenchurchillprivatecapitalincomefund","nuveenchurchillprivatecreditfund",
  "oaktreegardensolpllc","oaktreespecialtylendingcorp","oaktreestrategiccreditfund","ofscapitalcorp",
  "ohaseniorprivatelendingfundullc","onexdirectlendingbdcfund","overlandadvantage","oxfordsquarecapitalcorp",
  "palmersquarecapitalbdcinc","partnersgrouplendingfundllc","pennantparkfloatingratecapitalltd","pennantparkinvestmentcorp",
  "pgimprivatecreditfund","pharoscapitalbdcinc","phenixfincorp","phillipstreetbdcllc",
  "pimcocapitalsolutionsbdccorp","poliwoggregenerativemedicinefundinc","porticoescapitalcorp","princetoncapitalcorp",
  "principalmortgagefundinc","principalstructurefundinc","prospectcapitalcorp","prospectfloatingrateandalternativeincomefundinc",
  "randcapitalcorp","remoracapitalcorp","runwaygrowthfinancecorp","saratogainvestmentcorp",
  "scpprivatecreditincomebdcllc","seniorcreditinvestmentsllc","silvercapitalholdingsllc","sixthstreetlendingpartners",
  "slinvestmentfundiillc","slrhcbdcllc","slrinvestmentcorp","slrprivatecreditbdciillc",
  "soundpointdirectlendingbdc","starmountainlowermiddlemarketcapitalcorp","steelecreekcapitalcorp","stelluscapitalinvestmentcorp",
  "stellusprivatecreditbdc","stepstoneprivatecreditfundllc","stonepointcreditcorp","stonepointcreditincomefund",
  "stonepointcreditincomefundselect","sumufundinc","superiorcommunitycapitalcorp","surocapitalcorp",
  "tcwdirectlendingllc","tcwdirectlendingviiillc","tcwdirectlendingviillc","tcwmiddlemarketlendingopportunitiesbdcinc",
  "tcwspecialtylendingllc","tcwstardirectlendingllc","thirdpointprivatecapitalincomefund","thirdpointprivatecapitalpartners",
  "thlcreditlakeshoreinc","thlinvestmentcapitalcorp","tpgtwinbrookcapitalincomefund","triancapitalcorp",
  "trianglemezzaninefundlllp","triarcdeerfieldinvestmentcorp","triplepointprivateventurecreditinc","triplepointventuregrowthbdccorp",
  "trowepriceohaselectprivatecreditfund","tseriesbdcllc","vcvillagecomopportunityfundllc","venturelendingandleasingixinc",
  "vistacreditstrategiclendingcorp","westbaybdcllc","westerncapitalcorp","westfordtechnologyventureslp",
  "whitehorsefinanceinc","willowtreecapitalcorp","wtifundxiinc","wtifundxinc",
  "x1capitalinc","yorkecapitalcorp"
]);

function issuerKey(name) {
  if(typeof name!=='string')return '';
  return name.toLowerCase()
    .replace(/\b(?:class\s+[a-z0-9]+\s+)?(?:common\s+(?:stock|shares?)|ordinary\s+shares?|american\s+deposit(?:a|o)ry\s+(?:shares?|receipts?))\b.*$/i,'')
    .replace(/&/g,' and ').replace(/\bcorporation\b/g,'corp').replace(/\bincorporated\b/g,'inc')
    .replace(/\blimited\b/g,'ltd').replace(/\bthe\b/g,'').replace(/[^a-z0-9]/g,'');
}

export function isRegisteredBDC(issuerName) {return names.has(issuerKey(issuerName));}
