import { describe, expect, it } from 'vitest'
import { classifyUpbitTitle } from '../research/upbitTitles'

// research/upbitTitles.ts reads Upbit's trading notices for the Upbit study (research/UPBIT.md).
// Every title below is one Upbit published, copied as its list gives it.

const tickers = (title: string): string[] | undefined => classifyUpbitTitle(title)?.tickers

describe('a KRW listing', () => {
  it('names the coins given a won market, in each way the titles have put it since 2023', () => {
    expect(classifyUpbitTitle('돌핀(POD) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)')).toEqual({ category: 'KRW_LISTING', tickers: ['POD'] })
    expect(tickers('디파이앱(HOME) 신규 거래지원 안내 (KRW, USDT 마켓)')).toEqual(['HOME'])
    expect(tickers('펜들(PENDLE) 신규 거래지원 안내 (KRW, BTC 마켓) (가상자산 정보 제공 강화에 관한 안내)')).toEqual(['PENDLE'])
    expect(tickers('스퀴드(QUID) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (매도 최저가 기준 가격 안내)')).toEqual(['QUID'])
    expect(tickers('제로지(0G) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (거래지원 개시 시점 및 매도 최저가 기준 가격 안내)')).toEqual(['0G'])
    expect(tickers('폴리스웜(NCT) KRW 마켓 디지털 자산 추가')).toEqual(['NCT'])
    expect(tickers('바이프로스트(BFC) KRW, USDT 마켓 디지털 자산 추가')).toEqual(['BFC'])
    expect(tickers('오일러(EUL) KRW 마켓 디지털 자산 추가 (거래지원 개시 시점 변경 안내)')).toEqual(['EUL'])
  })

  it('gives each coin its own markets where the title gives them', () => {
    expect(tickers('셀레스티아(TIA)(KRW, BTC, USDT 마켓), 아이오넷(IO)(BTC, USDT 마켓) 신규 거래지원 안내 (주문 타입 제한 관련 안내)')).toEqual(['TIA'])
    expect(tickers('라이브피어(LPT)(KRW, USDT 마켓), 포켓네트워크(POKT)(KRW 마켓) 디지털 자산 추가')).toEqual(['LPT', 'POKT'])
    expect(classifyUpbitTitle('인피닛(IN) BTC, USDT 마켓, 비쓰리(B3) USDT 마켓 신규 거래지원 안내')).toBeNull()
  })

  it('reads 2018 to 2022, the markets first', () => {
    expect(tickers('KRW 마켓 디지털 자산 추가 (ID)')).toEqual(['ID'])
    expect(tickers('KRW 마켓 디지털 자산 추가 (ASTR) (거래지원 개시 시점 연기 안내)')).toEqual(['ASTR'])
    expect(tickers('원화 마켓 디지털 자산 추가 (AXS, STX, FLOW, DAWN)')).toEqual(['AXS', 'STX', 'FLOW', 'DAWN'])
    expect(tickers('원화 마켓 디지털 자산 추가 (도지코인 DOGE) (완료)')).toEqual(['DOGE'])
    expect(tickers('원화마켓 신규 상장 (샌드박스 SAND)')).toEqual(['SAND'])
    expect(tickers('원화마켓, BTC 마켓 신규 상장 (카바 KAVA)')).toEqual(['KAVA'])
    expect(tickers('원화 마켓 신규 거래 지원 (체인링크 LINK, 테조스 XTZ)')).toEqual(['LINK', 'XTZ'])
    expect(tickers('원화 마켓 신규 상장 (베이직어텐션토큰 BAT, 애드엑스 ADX, 애드토큰 ADT)')).toEqual(['BAT', 'ADX', 'ADT'])
    expect(tickers('원화 마켓 신규 상장 : 코스모스(ATOM)')).toEqual(['ATOM'])
    expect(tickers('원화 마켓 신규 상장 : (가스 GAS, 온톨로지가스 ONG)')).toEqual(['GAS', 'ONG'])
    expect(tickers('원화 마켓 신규 상장 시빅(CVC), 에브리피디아(IQ)')).toEqual(['CVC', 'IQ'])
    expect(tickers('원화 마켓 코인 추가 (디크레드 DCR)')).toEqual(['DCR'])
  })

  it('reads the 2019 notice that a won market will open, and the 2017 one that it had', () => {
    expect(tickers('헤데라해시그래프 (HBAR) 입금 지원 및 원화마켓 오픈 예고')).toEqual(['HBAR'])
    expect(tickers('코스모스(ATOM) 입금 오픈 (5/3 원화마켓 오픈 예정)')).toEqual(['ATOM'])
    expect(tickers('캐리프로토콜(CRE) 소개 및 원화마켓 오픈 예정 안내')).toEqual(['CRE'])
    expect(tickers('콘텐츠프로토콜토큰 (CPT) 입금 지원 및 원화마켓 상장 예고')).toEqual(['CPT'])
    expect(tickers('트웰브쉽스(TSHP) 소개 및 원화마켓 오픈 예정 안내 (원화마켓, BTC 마켓 오픈 완료)')).toEqual(['TSHP'])
    expect(tickers('피벡스(PIVX) 원화 마켓 오픈')).toEqual(['PIVX'])
  })

  it('says when one list of markets is shared by several coins, and not otherwise', () => {
    expect(classifyUpbitTitle('KRW, BTC 마켓 디지털 자산 추가 (SHIB, GAL)')).toEqual({ category: 'KRW_LISTING', tickers: ['SHIB', 'GAL'], shared: true })
    expect(classifyUpbitTitle('빅타임(BIGTIME), 아카시네트워크(AKT) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (AKT 거래지원 개시 시점 연기 안내)')?.shared).toBe(true)
    // A dollar is dropped, and still shares the list.
    expect(classifyUpbitTitle('스카이프로토콜(SKY), 유에스디에스(USDS) KRW, USDT 마켓 디지털 자산 추가 (USDS 거래지원 개시 시점 변경 안내)')).toEqual({
      category: 'KRW_LISTING',
      tickers: ['SKY'],
      shared: true
    })
    for (const title of [
      '원화 마켓 디지털 자산 추가 (AXS, STX, FLOW, DAWN)',
      '원화 마켓 신규 거래 지원 (체인링크 LINK, 테조스 XTZ)',
      '펜들(PENDLE) 신규 거래지원 안내 (KRW, BTC 마켓) (가상자산 정보 제공 강화에 관한 안내)',
      '라이브피어(LPT)(KRW, USDT 마켓), 포켓네트워크(POKT)(KRW 마켓) 디지털 자산 추가'
    ]) {
      expect(classifyUpbitTitle(title)?.shared, title).toBeUndefined()
    }
  })

  it('is not a listing in the BTC or USDT market alone, a pegged coin, or one named in Korean alone', () => {
    for (const title of [
      '이더파이(ETHFI), 리졸브(RESOLV), 이니시아(INIT), 스파크(SPK) 신규 거래지원 안내 (BTC, USDT 마켓)',
      '렌조(REZ) 신규 거래지원 안내 (USDT 마켓) (거래지원 개시 시점 추가 변경 안내)',
      'BTC, USDT 마켓 신규 거래지원 안내 (BICO, BMT, NIL, GWEI) (BICO, BMT, NIL, GWEI 거래지원 개시 시점 추가 변경 안내)',
      'BTC 마켓 디지털 자산 추가 (ARPA, ENS)',
      'USDT 마켓 디지털 자산 추가 (AGLD, AHT, ARPA, ASTR, BNT, EGLD, FIL, LWA, NEAR, OXT, RAD, XLM)',
      'BTC 마켓 코인 추가 (스택스 STX)',
      '유에스디코인(USDC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
      '페이팔유에스디(PYUSD), 제이피와이코인(JPYC) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (JPYC 거래지원 개시 시점 추가 변경 안내)',
      '글로벌달러(USDG) 신규 거래지원 안내 (KRW, BTC, USDT 마켓) (거래지원 개시 시점 추가 변경 안내)',
      '테더골드(XAUT) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)',
      '네오, 오미세고, 리스크 원화 마켓 오픈',
      '아더(Ardor) 거래 재개 안내 (BTC, KRW 마켓)',
      'IOTA 원화마켓 상장 일정 변경 및 이벤트 수정 사항 안내'
    ]) {
      expect(classifyUpbitTitle(title), title).toBeNull()
    }
  })
})

describe('a caution designation', () => {
  it('names the coins designated, since 2024 and before', () => {
    expect(classifyUpbitTitle('블라스트(BLAST) 거래 유의 종목 지정 안내')).toEqual({ category: 'CAUTION', tickers: ['BLAST'] })
    expect(tickers('폴카닷(DOT)  거래 유의 종목 지정 안내')).toEqual(['DOT'])
    expect(tickers('다드(DAD), 비트코인골드(BTG) 거래 유의 종목 지정 안내')).toEqual(['DAD', 'BTG'])
    expect(tickers('포튜브(FOR) 유의 종목 지정 안내')).toEqual(['FOR'])
    expect(tickers('던프로토콜(DAWN), 리퍼리움(RFR), 마로(MARO) 유의 종목 지정 안내')).toEqual(['DAWN', 'RFR', 'MARO'])
    expect(tickers('LUNA 유의 종목 지정 안내')).toEqual(['LUNA'])
    expect(tickers('디지털 자산 유의종목 지정 안내 Cred(LBA)')).toEqual(['LBA'])
  })

  it('is not one lifted, extended, temporary or counted, nor Upbit urging caution', () => {
    for (const title of [
      '샌드박스(SAND) 거래 유의 종목 지정 해제 안내',
      '랠리(RLY) 유의 종목 지정 해제 안내',
      '만트라(MANTRA) 거래 유의 종목 지정 기간 연장 안내',
      '플레이댑(PLA) 유의 종목 지정 기간 연장 안내',
      '리퍼리움(RFR) 유의 종목 지정 안내 (기간 연장)',
      'IOST 유의 종목 일시 지정 안내 (입출금 오픈 11/19 16:00~)',
      '디지털 자산 유의 종목 지정 안내 (25종)',
      '암호화폐 유의 종목 지정 안내 (18종)',
      '샌드박스(SAND) 유의 촉구 안내',
      '스택스(STX) 투자 유의 촉구 안내',
      '엔진코인(ENJ) 메인넷 전환 및 유의 종목 지정에 따른 입출금 중단 안내'
    ]) {
      expect(classifyUpbitTitle(title), title).toBeNull()
    }
  })
})

describe('a delisting', () => {
  it('names the coins Upbit stops supporting', () => {
    expect(classifyUpbitTitle('아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)')).toEqual({ category: 'DELISTING', tickers: ['ICX'] })
    expect(tickers('재스미코인(JASMY) 거래지원 종료 안내(9/14 15:00)')).toEqual(['JASMY'])
    expect(tickers('던프로토콜(DAWN), 리퍼리움(RFR), 마로(MARO) 거래지원 종료 안내 (09/26 16:00)')).toEqual(['DAWN', 'RFR', 'MARO'])
    expect(tickers('썸씽(SSX) 거래지원 종료 안내 (3/12 15:00) (출금 재개 안내)')).toEqual(['SSX'])
    expect(tickers('썬더코어(TT) 거래지원 종료 안내 (거래지원 종료 일정 변경 안내)')).toEqual(['TT'])
    expect(tickers('고머니2(GOM2) 거래 지원 종료 안내')).toEqual(['GOM2'])
    expect(tickers('모네로(XMR), 대쉬(DASH), 제트캐시(ZEC), 헤이븐(XHV), 비트튜브(TUBE), 피벡스(PIVX) 거래 지원 종료 안내 (19.09.30 종료)')).toEqual([
      'XMR',
      'DASH',
      'ZEC',
      'XHV',
      'TUBE',
      'PIVX'
    ])
    expect(tickers('머큐리(MER), 뫼비우스(MOBI) 거래 지원 종료 안내 (완료)')).toEqual(['MER', 'MOBI'])
    expect(tickers('AGRS, MAID, 1ST 거래지원 종료 안내')).toEqual(['AGRS', 'MAID', '1ST'])
    expect(tickers('콘텐츠프로토콜토큰(CPT) 사업 종료에 따른 거래지원 종료 안내')).toEqual(['CPT'])
  })

  it('is not the end of one market or pair, a buyback or swap, a count, or a change of date', () => {
    for (const title of [
      '인터넷오브피플(IOP) BTC 마켓 거래 지원 종료 안내',
      'BTG(비트코인골드) BTC/ETH/USDT 마켓 거래 지원 종료 안내',
      'PAX/USDT 마켓 거래 지원 종료 안내',
      'RLC(아이젝) ETH 마켓 거래 지원 종료 안내',
      '엔진코인(ENJ) KRW 마켓 거래지원 종료(10/10 18:00) 및 BTC 마켓 유의 종목 지정 해제 안내',
      '디지털 자산 원화마켓 페어 제거 안내 (5종)',
      'SERV(서브토큰) 사업 종료에 따른 거래지원 종료 및 바이백 진행 안내',
      'MCO 거래 지원 종료 및 MCO 스왑 프로그램 안내',
      '24종 디지털 자산 거래지원 종료 안내 (코모도(KMD) 외 22종, 2021.06.28(월) 12:00 / 아인스타이늄(EMC2), 2021.07.03(토) 12:00)',
      '디지털 자산 거래 지원 종료 안내 (3종) - FSN, NKN, GO 유의 종목 해제',
      'ThunderCore 네트워크 종료에 따른 썬더코어(TT) 출금 중단(종료) 및 거래지원 종료 예정일 변경 안내 (09/01 09:00 ~)',
      'CFI(코파운드잇) 거래지원 종료 및 청산 절차에 대한 안내'
    ]) {
      expect(classifyUpbitTitle(title), title).toBeNull()
    }
  })
})
