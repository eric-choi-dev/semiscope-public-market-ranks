import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateRawSync} from 'node:zlib';
import {extractCompanyFacts,extractSecurityEvidence,previousCover,selectPeriodic,bulkCompanyFacts} from './quality-sec-metrics.mjs';

const asOf='2026-11-23',cik='0000320193';
const old='0000320193-26-000002',latest='0000320193-26-000012';
const row=(end,val,filed,accn=latest,form='10-Q',extra={})=>({end,val,filed,accn,form,...extra});
function example(shares,income=[],assets=[]) {
  return {cik:Number(cik),facts:{dei:{EntityCommonStockSharesOutstanding:{units:{shares}}},
    'us-gaap':{NetIncomeLoss:{units:{USD:income}},Assets:{units:{USD:assets}}}}};
}
test('only recently issued shares from the latest available domestic filing count',()=>{
  const published=row('2026-10-23',111,'2026-11-03');
  const before=row('2026-07-25',100,'2026-08-01',old);
  const future=row('2026-11-15',999,'2026-11-24','0000320193-26-000014');
  assert.equal(extractCompanyFacts(example([published,before,future]),asOf).cover.val,111);
  assert.equal(extractCompanyFacts(example([before],[],[row('2026-09-30',450,'2026-11-03')]),asOf).cover,null);
  assert.equal(extractCompanyFacts(example([row('2026-04-01',222,'2026-05-01')]),asOf).cover,null);
  assert.equal(extractCompanyFacts(example([published,{...published,val:120}]),asOf).cover,null);
  assert.equal(extractCompanyFacts(example([{...published,form:'20-F'}]),asOf).cover,null);
});

test('annual net income uses a completed filed fiscal year and preserves actual losses',()=>{
  const annual=row('2026-09-26',-17,'2026-11-03',latest,'10-K',{start:'2025-09-28'});
  const inflight={...annual,val:400,start:'2026-07-01'};
  const future={...annual,val:100,filed:'2026-11-30'};
  assert.deepEqual(extractCompanyFacts(example([],[annual,inflight,future]),asOf).annual,annual);
});

const context=(id,member,date,who=cik,extra='')=>'<xbrli:context id="'+id+'"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">'+who+
  '</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">'+member+
  '</xbrldi:explicitMember>'+extra+'</xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>'+date+'</xbrli:instant></xbrli:period></xbrli:context>';
const title=(id,label)=>'<ix:nonNumeric contextRef="'+id+'" name="dei:Security12bTitle">'+label+'</ix:nonNumeric>';
const ticker=(id,name,label='Common Stock')=>'<ix:nonNumeric contextRef="'+id+'" name="dei:TradingSymbol"><span>'+name+'</span></ix:nonNumeric>'+title(id,label);
const count=(id,n,unit='shares',scale=0)=>'<ix:nonFraction name="dei:EntityCommonStockSharesOutstanding" unitRef="'+unit+'" contextRef="'+id+'" scale="'+scale+'">'+n+'</ix:nonFraction>';
const units='<xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>';
test('two issuers’ contexts, different stock classes, unlisted stock and debt stay distinct',()=>{
  const a='us-gaap:CommonClassAMember',b='f:ClassBMember',c='f:UnlistedClassCMember';
  const doc=units+context('a',a,'2026-09-30')+context('b',b,'2026-09-30')+context('c',c,'2026-09-30')+
    context('ac',a,'2026-10-23')+context('wrong',a,'2026-10-23','0000000003')+
    context('loan','f:Bond','2026-09-30')+ticker('a','BRK.A','Class A common stock')+ticker('b','BRK-B','Class B common stock')+ticker('loan','BRK28','Senior Notes')+
    count('ac','123,500')+count('b','2,000','shares',3)+count('c','150')+count('wrong','999')+count('loan','2000','USD');
  const result=extractSecurityEvidence(doc,cik,asOf,'2026-11-03').items;
  assert.deepEqual(Object.keys(result),['BRK.A','BRK.B']);assert.equal(result['BRK.A'].val,123500);assert.equal(result['BRK.B'].val,2000000);
});
test('ambiguous class identification, competing counts and post-cutoff share observations cannot qualify',()=>{
  const member='f:ClassOne';const base=units+context('q',member,'2026-10-22')+ticker('q','EX');
  for(const extra of [count('q',10)+count('q',11),ticker('q','EX.B')+count('q',100),
    context('future',member,'2026-11-25')+count('future',10),
    context('seg',member,'2026-10-22',cik,'<xbrldi:explicitMember dimension="s:Other">s:X</xbrldi:explicitMember>')+count('seg',10)]){
    assert.deepEqual(extractSecurityEvidence(base+extra,cik,asOf,'2026-11-03').items,{});
  }
});
const baseContext=(id,date)=>context(id,'',date).replace(/<xbrli:segment>[\s\S]*?<\/xbrli:segment>/,'');
test('a generic common listing can match the issuer total when other listed securities are explicitly preferred or notes',()=>{
  const doc=units+context('com','us-gaap:CommonStockMember','2026-09-30')+context('p','f:SeriesDPreferred','2026-09-30')+
    ticker('com','BANK')+ticker('p','BANK.PR.D','Depositary shares representing preferred stock')+
    baseContext('cover','2026-10-23')+count('cover','2,655,609,509');
  const {titles,items}=extractSecurityEvidence(doc,cik,asOf,'2026-11-03');
  assert.equal(titles.BANK,'Common Stock');assert.deepEqual(Object.keys(items),['BANK']);
  assert.equal(items.BANK.capBasis,'issuer');assert.equal(items.BANK.val,2655609509);
  assert.equal(extractSecurityEvidence(doc+context('a','f:UnlistedCommonMember','2026-10-23')+count('a','111'),cik,asOf,'2026-11-03').items.BANK,undefined);
});
test('only explicitly debt or preferred siblings can repeat the common ticker',()=>{
  const file=units+context('normal','us-gaap:CommonStockMember','2026-09-30')+
    context('note','co:SeniorNoteMember','2026-09-30')+ticker('normal','MSFT')+
    baseContext('cover','2026-10-22')+count('cover','7,426,194,552');
  assert.equal(extractSecurityEvidence(file+ticker('note','MSFT','3.125% Notes due 2028'),cik,asOf,'2026-11-03').items.MSFT.val,7426194552);
  assert.deepEqual(extractSecurityEvidence(file+ticker('note','MSFT','Class B common shares'),cik,asOf,'2026-11-03').items,{});
  assert.deepEqual(extractSecurityEvidence(file+ticker('note','MSFT','Unspecified'),cik,asOf,'2026-11-03').items,{});
});
test('unsegmented ticker with explicit class A title matches only standard Class A share fact',()=>{
  const doc=units+baseContext('main','2026-09-30')+ticker('main','EX','Class A common stock, $0.001 par value')+
    context('a','us-gaap:CommonClassAMember','2026-10-23')+context('b','us-gaap:CommonClassBMember','2026-10-23');
  const {titles,items}=extractSecurityEvidence(doc+count('a','101')+count('b','87'),cik,asOf,'2026-11-03');
  assert.equal(titles.EX,'Class A common stock, $0.001 par value');
  assert.equal(items.EX.val,101);assert.equal(items.EX.capBasis,'listedClassLowerBound');
  assert.deepEqual(extractSecurityEvidence(doc+count('b','87')+count('main','999'),cik,asOf,'2026-11-03').items,{});
  assert.deepEqual(extractSecurityEvidence(doc+ticker('main','OTHER')+count('a','101'),cik,asOf,'2026-11-03').items,{});
});
test('exchange dimension identifies the listing but never contributes issuer shares',()=>{
  const exchange='<xbrldi:explicitMember dimension="dei:EntityListingsExchangeAxis">exch:XNYS</xbrldi:explicitMember>';
  const file=units+context('listed','us-gaap:CommonStockMember','2026-09-30',cik,exchange)+ticker('listed','CO')+
    baseContext('cover','2026-10-29')+count('cover','480');
  const result=extractSecurityEvidence(file,cik,asOf,'2026-11-06').items;
  assert.equal(result.CO.val,480);assert.equal(result.CO.capBasis,'issuer');
});
test('the same common class on two exchanges has one issuer total and decimal data use exact scaling',()=>{
  const exchange=venue=>'<xbrldi:explicitMember dimension="dei:EntityListingsExchangeAxis">'+venue+'</xbrldi:explicitMember>';
  const doc=units+context('ny','us-gaap:CommonStockMember','2026-09-30',cik,exchange('exch:XNYS'))+
    context('chi','us-gaap:CommonStockMember','2026-09-30',cik,exchange('exch:XCHI'))+ticker('ny','“CO”')+ticker('chi','CO (NYSE)')+
    baseContext('cover','2026-10-29')+count('cover','256.4','shares',6);
  assert.equal(extractSecurityEvidence(doc,cik,asOf,'2026-11-06').items.CO.val,256400000);
  assert.deepEqual(extractSecurityEvidence(doc+title('chi','Series D Preferred Stock'),cik,asOf,'2026-11-06').items,{});
});
test('a class capital stock needs a matching class-specific explicitly common DEI fact',()=>{
  const file=units+context('listed','co:CapitalClassCMember','2026-09-30')+ticker('listed','CO','Class C Capital Stock, $0.01 par value')+
    context('cover','co:CapitalClassCMember','2026-10-21');
  assert.equal(extractSecurityEvidence(file+count('cover','577'),cik,asOf,'2026-10-29').items.CO.val,577);
  assert.deepEqual(extractSecurityEvidence(file+baseContext('total','2026-10-21')+count('total','999'),cik,asOf,'2026-10-29').items,{});
});
test('latest original domestic periodic filing comes from chronological published submissions before price day',()=>{
  const recent={accessionNumber:[old,latest,'0000320193-26-000014','0000320193-26-000015'],
    form:['10-Q','10-K','10-Q','8-K'],filingDate:['2026-08-07','2026-11-03',asOf,'2026-11-20'],
    primaryDocument:['aug.htm','annual.htm','later.htm','report.htm']};
  const subject={cik:Number(cik),filings:{recent}};
  assert.equal(selectPeriodic(subject,cik,asOf).accn,latest);
  assert.throws(()=>selectPeriodic(subject,'0000000022',asOf),/identity|issuer/);
  assert.equal(selectPeriodic(subject,cik,'2026-07-31'),null);
});
test('reused evidence must match symbol, CIK, latest accession, issuer count and qualifying title',()=>{
  const url='https://www.sec.gov/Archives/edgar/data/320193/'+latest.replaceAll('-','')+'/aapl.htm';
  const form={accn:latest,filed:'2026-11-03'},cover={val:500,end:'2026-10-23'};
  const row={symbol:'AAPL',cik,shares:500,sharesFiled:form.filed,sharesAsOf:cover.end,capBasis:'issuer',
    verifiedCommon:true,securityTitle:'Common Stock',filingUrl:url,securityTitleSource:url};
  assert.equal(previousCover(row,cik,'AAPL',form,asOf,cover).share.val,500);
  for(const changed of [{shares:999},{symbol:'XYZ'},{verifiedCommon:false},{securityTitle:'Preferred shares'},{cik:'42'},{filingUrl:url.replace('320193','1001')}])
    assert.equal(previousCover({...row,...changed},cik,'AAPL',form,asOf,cover),null);
  assert.equal(previousCover(row,cik,'AAPL',{...form,accn:old},asOf,cover),null);
});

function bulkFixture(damaged=false) {
  const record=example([row('2026-10-23',111,'2026-11-03')]);
  const raw=Buffer.from(JSON.stringify(record)),packed=deflateRawSync(raw),name=Buffer.from('CIK'+cik+'.json');
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(8,8);header.writeUInt16LE(name.length,26);
  const center=Buffer.alloc(46);center.writeUInt32LE(0x02014b50);center.writeUInt16LE(8,10);
  center.writeUInt32LE(damaged?0:crc32(raw),16);center.writeUInt32LE(packed.length,20);center.writeUInt32LE(raw.length,24);center.writeUInt16LE(name.length,28);
  const footer=Buffer.alloc(22);footer.writeUInt32LE(0x06054b50);footer.writeUInt16LE(1,8);footer.writeUInt16LE(1,10);
  footer.writeUInt32LE(center.length+name.length,12);footer.writeUInt32LE(header.length+name.length+packed.length,16);
  const archive=Buffer.concat([header,name,packed,center,name,footer]);
  return {stat:async()=>({size:archive.length}),read:async(buffer,offset,size,start)=>({bytesRead:archive.copy(buffer,offset,start,start+size)})};
}
test('official bulk format extracts the requested issuer with checksum and never substitutes another CIK',async()=>{
  const args={archive:bulkFixture(),asOf,ciks:[cik,'0000000021']};
  const records=await bulkCompanyFacts(args);assert.deepEqual(Object.keys(records),[cik]);assert.equal(records[cik].cover.val,111);
  await assert.rejects(bulkCompanyFacts({...args,archive:bulkFixture(true)}),/checksum/);
});
