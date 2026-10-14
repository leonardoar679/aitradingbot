import type { Language } from './languages'

// THE TERMINOLOGY DICTIONARY (the V6 document, §84; V6 Stage 14, 13 October 2026). One official
// translation of each trading term in each language, first in its list; the forms after it are the same
// term as a sentence inflects or joins it (an Arabic article, a Hindi oblique plural), never another word.
// Every catalog in ./locales was written against it.
//
// A term with a `pin` is held to it by tests/i18n.test.ts: every key whose English the pin finds says
// one of the term's forms, in every language, so a stop is never a stop in one sentence and a halt in the
// next. A term the English uses in more than one sense (an order, a position, a stop) has no pin; its
// translation is still the one given here.
//
// The page names are terms too: a sentence that sends someone to Risk & Safety names the page the
// sidebar shows.

export type TranslatedLanguage = Exclude<Language, 'en'>

export interface Term {
  /** The term as the English writes it. */
  en: string
  /** What it means in this app. */
  sense: string
  /** The official translation in each language, then the forms a sentence may give it. */
  forms: Readonly<Record<TranslatedLanguage, readonly string[]>>
  /** Finds the term in a key's English, for the test; none for a term the English uses in several senses. */
  pin?: RegExp
}

export const TERMS: readonly Term[] = [
  // ---------------------------------------------------------------- what is real and what is not
  {
    en: 'paper',
    sense: 'simulated: a trade or position that moves no real money',
    forms: { 'zh-CN': ['模拟'], 'zh-TW': ['模擬'], ja: ['ペーパー'], ko: ['모의'], vi: ['mô phỏng'], th: ['จำลอง'], id: ['simulasi'], hi: ['पेपर'], ar: ['تجريبي'] },
    pin: /\bpaper\b/i
  },
  {
    en: 'live, real',
    sense: 'with real money, on the exchange',
    forms: { 'zh-CN': ['实盘', '真实'], 'zh-TW': ['實盤', '真實'], ja: ['リアル', '実際の'], ko: ['실거래', '실제'], vi: ['thật'], th: ['จริง'], id: ['nyata'], hi: ['लाइव', 'असली'], ar: ['حقيقي', 'الحقيقي', 'حقيقية'] }
  },
  // ---------------------------------------------------------------- an order and its levels
  {
    en: 'order',
    sense: 'an instruction to the exchange to buy or sell',
    forms: { 'zh-CN': ['订单'], 'zh-TW': ['訂單'], ja: ['注文'], ko: ['주문'], vi: ['lệnh'], th: ['คำสั่งซื้อขาย', 'คำสั่ง'], id: ['order'], hi: ['ऑर्डर'], ar: ['أمر', 'أوامر', 'الأمر', 'الأوامر'] }
  },
  {
    en: 'position',
    sense: 'what is held from an entry until it is closed',
    forms: { 'zh-CN': ['仓位'], 'zh-TW': ['倉位'], ja: ['ポジション'], ko: ['포지션'], vi: ['vị thế'], th: ['โพซิชัน'], id: ['posisi'], hi: ['पोज़िशन'], ar: ['مركز', 'المركز', 'مراكز', 'المراكز'] }
  },
  {
    en: 'entry',
    sense: 'where a position is opened',
    forms: { 'zh-CN': ['入场'], 'zh-TW': ['進場'], ja: ['エントリー'], ko: ['진입'], vi: ['vào lệnh', 'điểm vào'], th: ['จุดเข้า', 'เข้า'], id: ['entri'], hi: ['एंट्री'], ar: ['الدخول', 'دخول'] }
  },
  {
    en: 'stop, stop loss',
    sense: 'the price at which a position is closed at a loss',
    forms: { 'zh-CN': ['止损'], 'zh-TW': ['停損'], ja: ['損切り'], ko: ['손절'], vi: ['cắt lỗ'], th: ['จุดตัดขาดทุน', 'ตัดขาดทุน'], id: ['stop loss'], hi: ['स्टॉप लॉस', 'स्टॉप'], ar: ['وقف الخسارة'] }
  },
  {
    en: 'target, take profit',
    sense: 'the price at which a position is closed at a profit',
    forms: { 'zh-CN': ['止盈', '目标'], 'zh-TW': ['停利', '目標'], ja: ['利確'], ko: ['익절', '목표가'], vi: ['chốt lời'], th: ['จุดทำกำไร', 'ทำกำไร'], id: ['target'], hi: ['टारगेट'], ar: ['الهدف', 'هدف', 'جني الأرباح'] }
  },
  {
    en: 'trailing stop',
    sense: 'a stop that follows the price up',
    forms: { 'zh-CN': ['追踪止损'], 'zh-TW': ['追蹤停損'], ja: ['トレーリングストップ'], ko: ['트레일링 스탑'], vi: ['cắt lỗ động'], th: ['จุดตัดขาดทุนแบบเลื่อน'], id: ['trailing stop'], hi: ['ट्रेलिंग स्टॉप'], ar: ['وقف الخسارة المتحرك', 'وقف متحرك'] },
    pin: /trailing stop/i
  },
  {
    en: 'BUY',
    sense: 'a call or an order to buy; long',
    forms: { 'zh-CN': ['买入'], 'zh-TW': ['買進'], ja: ['買い'], ko: ['매수'], vi: ['MUA'], th: ['ซื้อ'], id: ['BELI'], hi: ['खरीद'], ar: ['شراء'] },
    pin: /\bBUY/
  },
  {
    en: 'SELL',
    sense: 'a call or an order to sell; a short, which this app opens only on paper',
    forms: { 'zh-CN': ['卖出'], 'zh-TW': ['賣出'], ja: ['売り'], ko: ['매도'], vi: ['BÁN'], th: ['ขาย'], id: ['JUAL'], hi: ['बेच', 'बिक्री'], ar: ['بيع'] },
    pin: /\bSELL/
  },
  {
    en: 'short',
    sense: 'a position that gains when the price falls',
    forms: { 'zh-CN': ['做空', '空单'], 'zh-TW': ['做空', '空單'], ja: ['ショート'], ko: ['숏'], vi: ['bán khống'], th: ['ชอร์ต'], id: ['short'], hi: ['शॉर्ट'], ar: ['بيع على المكشوف', 'البيع على المكشوف'] }
  },
  {
    en: 'leverage',
    sense: 'a deposit controlling a larger amount',
    forms: { 'zh-CN': ['杠杆'], 'zh-TW': ['槓桿'], ja: ['レバレッジ'], ko: ['레버리지'], vi: ['đòn bẩy'], th: ['เลเวอเรจ'], id: ['leverage'], hi: ['लीवरेज'], ar: ['رافعة', 'الرافعة'] },
    pin: /leverag/i
  },
  // ---------------------------------------------------------------- what a trade costs, and the market it meets
  {
    en: 'fee',
    sense: "the exchange's charge on a fill",
    forms: { 'zh-CN': ['手续费'], 'zh-TW': ['手續費'], ja: ['手数料'], ko: ['수수료'], vi: ['phí'], th: ['ค่าธรรมเนียม'], id: ['biaya'], hi: ['शुल्क'], ar: ['رسوم', 'الرسوم'] },
    pin: /\bfees?\b/i
  },
  {
    en: 'slippage',
    sense: 'what a fill gives up against the price that was seen',
    forms: { 'zh-CN': ['滑点'], 'zh-TW': ['滑價'], ja: ['スリッページ'], ko: ['슬리피지'], vi: ['trượt giá'], th: ['สลิปเพจ'], id: ['slippage'], hi: ['स्लिपेज'], ar: ['الانزلاق', 'انزلاق'] },
    pin: /slippage/i
  },
  {
    en: 'spread',
    sense: 'the gap between the best bid and the best ask',
    forms: { 'zh-CN': ['价差'], 'zh-TW': ['價差'], ja: ['スプレッド'], ko: ['스프레드'], vi: ['chênh lệch giá'], th: ['สเปรด'], id: ['spread'], hi: ['स्प्रेड'], ar: ['الفارق', 'فارق'] },
    pin: /\bspread\b/i
  },
  {
    en: 'order book',
    sense: 'the bids and asks resting on the exchange',
    forms: { 'zh-CN': ['订单簿'], 'zh-TW': ['委託簿'], ja: ['板'], ko: ['호가창'], vi: ['sổ lệnh'], th: ['สมุดคำสั่งซื้อขาย'], id: ['buku order'], hi: ['ऑर्डर बुक'], ar: ['دفتر الأوامر'] }
  },
  {
    en: 'volatility',
    sense: 'how far the price usually moves',
    forms: { 'zh-CN': ['波动'], 'zh-TW': ['波動'], ja: ['ボラティリティ'], ko: ['변동성'], vi: ['biến động'], th: ['ผันผวน'], id: ['volatilitas'], hi: ['अस्थिरता'], ar: ['تقلب', 'التقلب'] },
    pin: /volatil/i
  },
  {
    en: 'liquidity',
    sense: 'how much can be traded near the price',
    forms: { 'zh-CN': ['流动性'], 'zh-TW': ['流動性'], ja: ['流動性'], ko: ['유동성'], vi: ['thanh khoản'], th: ['สภาพคล่อง'], id: ['likuiditas'], hi: ['तरलता'], ar: ['سيولة', 'السيولة'] },
    pin: /liquidity/i
  },
  {
    en: 'candle',
    sense: "one bar of a pair's prices over a minute, an hour or a day",
    forms: { 'zh-CN': ['K线'], 'zh-TW': ['K線'], ja: ['ローソク足'], ko: ['캔들'], vi: ['nến'], th: ['แท่งเทียน'], id: ['candle'], hi: ['कैंडल'], ar: ['شمعة', 'شموع', 'الشمعة', 'الشموع'] },
    pin: /\bcandles?\b/i
  },
  {
    en: 'pair',
    sense: 'a market of one coin against another: SOL/USDT',
    forms: { 'zh-CN': ['交易对'], 'zh-TW': ['交易對'], ja: ['ペア'], ko: ['거래쌍'], vi: ['cặp'], th: ['คู่'], id: ['pasangan'], hi: ['पेयर'], ar: ['زوج', 'أزواج', 'الزوج', 'الأزواج'] },
    pin: /\bpairs?\b/i
  },
  {
    en: 'coin',
    sense: 'a crypto asset',
    forms: { 'zh-CN': ['币'], 'zh-TW': ['幣'], ja: ['コイン'], ko: ['코인'], vi: ['coin'], th: ['เหรียญ'], id: ['koin'], hi: ['कॉइन'], ar: ['عملة', 'عملات', 'العملة', 'العملات'] },
    pin: /\bcoins?\b/i
  },
  {
    en: 'Bitcoin',
    sense: 'BTC',
    forms: { 'zh-CN': ['比特币'], 'zh-TW': ['比特幣'], ja: ['ビットコイン'], ko: ['비트코인'], vi: ['Bitcoin'], th: ['บิตคอยน์'], id: ['Bitcoin'], hi: ['बिटकॉइन'], ar: ['بيتكوين'] },
    pin: /bitcoin/i
  },
  {
    en: 'regime',
    sense: "the market's state: bull, bear, sideways, high volatility, panic",
    forms: { 'zh-CN': ['市场状态', '状态'], 'zh-TW': ['市場狀態', '狀態'], ja: ['相場局面', '局面'], ko: ['시장 국면', '국면'], vi: ['trạng thái thị trường', 'trạng thái'], th: ['สภาวะตลาด', 'สภาวะ'], id: ['rezim'], hi: ['बाज़ार की स्थिति', 'स्थिति'], ar: ['حالة السوق', 'حالة'] },
    pin: /regime/i
  },
  {
    en: 'bullish',
    sense: 'expecting the price to rise',
    forms: { 'zh-CN': ['看涨'], 'zh-TW': ['看漲'], ja: ['強気'], ko: ['강세'], vi: ['tăng giá'], th: ['ขาขึ้น'], id: ['bullish'], hi: ['तेज़ी'], ar: ['صعودي', 'صعودية', 'صعود'] },
    pin: /bullish/i
  },
  {
    en: 'bearish',
    sense: 'expecting the price to fall',
    forms: { 'zh-CN': ['看跌'], 'zh-TW': ['看跌'], ja: ['弱気'], ko: ['약세'], vi: ['giảm giá'], th: ['ขาลง'], id: ['bearish'], hi: ['मंदी'], ar: ['هبوطي', 'هبوطية', 'هبوط'] },
    pin: /bearish/i
  },
  // ---------------------------------------------------------------- the forecast and its measures
  {
    en: 'forecast',
    sense: "the engine's range of where the price may be at a horizon",
    forms: { 'zh-CN': ['预测'], 'zh-TW': ['預測'], ja: ['予測'], ko: ['예측'], vi: ['dự báo'], th: ['คาดการณ์'], id: ['prakiraan'], hi: ['पूर्वानुमान'], ar: ['توقع', 'التوقع', 'توقعات', 'التوقعات'] },
    pin: /forecast/i
  },
  {
    en: 'prediction',
    sense: 'a forecast as it is shown and ranked',
    forms: { 'zh-CN': ['预测'], 'zh-TW': ['預測'], ja: ['予測'], ko: ['예측'], vi: ['dự đoán'], th: ['ทำนาย'], id: ['prediksi'], hi: ['भविष्यवाण'], ar: ['تنبؤ', 'التنبؤ', 'تنبؤات', 'التنبؤات'] },
    pin: /predict/i
  },
  {
    en: 'confidence',
    sense: "how sure a model or the forecast is of what it calls; not a probability of profit",
    forms: { 'zh-CN': ['置信度'], 'zh-TW': ['置信度'], ja: ['確信度'], ko: ['확신도'], vi: ['mức tin cậy'], th: ['ความมั่นใจ'], id: ['keyakinan'], hi: ['विश्वास'], ar: ['ثقة', 'الثقة'] },
    pin: /confidence/i
  },
  {
    en: 'reliability',
    sense: "how far a forecast's record can be trusted: its sample, coverage and agreement",
    forms: { 'zh-CN': ['可靠性'], 'zh-TW': ['可靠性'], ja: ['信頼性'], ko: ['신뢰성'], vi: ['độ tin cậy'], th: ['ความน่าเชื่อถือ'], id: ['keandalan'], hi: ['विश्वसनीयता'], ar: ['موثوقية', 'الموثوقية', 'موثوقيت'] },
    pin: /reliab/i
  },
  {
    en: 'calibrated',
    sense: 'checked against what happened, so that 80% means 80%',
    forms: { 'zh-CN': ['校准'], 'zh-TW': ['校準'], ja: ['較正'], ko: ['보정'], vi: ['hiệu chỉnh'], th: ['ปรับเทียบ'], id: ['kalibrasi'], hi: ['कैलिब्रे'], ar: ['معاير', 'المعاير', 'معايرة', 'المعايرة'] },
    pin: /calibrat/i
  },
  {
    en: 'win rate',
    sense: 'the share of trades closed ahead',
    forms: { 'zh-CN': ['胜率'], 'zh-TW': ['勝率'], ja: ['勝率'], ko: ['승률'], vi: ['tỷ lệ thắng'], th: ['อัตราชนะ'], id: ['tingkat kemenangan'], hi: ['जीत दर'], ar: ['نسبة الربح'] },
    pin: /win rate/i
  },
  {
    en: 'expected value',
    sense: "what a trade makes on average, at its win rate, after its costs",
    forms: { 'zh-CN': ['期望值'], 'zh-TW': ['期望值'], ja: ['期待値'], ko: ['기대값'], vi: ['giá trị kỳ vọng'], th: ['ค่าคาดหวัง'], id: ['nilai harapan'], hi: ['अपेक्षित मान'], ar: ['القيمة المتوقعة', 'قيمة متوقعة', 'قيمته المتوقعة', 'قيمتها المتوقعة'] },
    pin: /expected value/i
  },
  {
    en: 'profit factor',
    sense: 'what the winners made over what the losers lost',
    forms: { 'zh-CN': ['盈利因子'], 'zh-TW': ['獲利因子'], ja: ['プロフィットファクター'], ko: ['수익 팩터'], vi: ['hệ số lợi nhuận'], th: ['ปัจจัยกำไร'], id: ['faktor profit'], hi: ['प्रॉफिट फैक्टर'], ar: ['عامل الربح'] },
    pin: /profit factor/i
  },
  {
    en: 'drawdown',
    sense: 'the fall from a high to the low after it',
    forms: { 'zh-CN': ['回撤'], 'zh-TW': ['回撤'], ja: ['ドローダウン'], ko: ['낙폭'], vi: ['mức sụt giảm'], th: ['ดรอว์ดาวน์'], id: ['drawdown'], hi: ['ड्रॉडाउन'], ar: ['التراجع', 'تراجع'] },
    pin: /drawdown/i
  },
  // ---------------------------------------------------------------- what the app watches and who it asks
  {
    en: 'event',
    sense: 'a move the scanner raises as unusual',
    forms: { 'zh-CN': ['事件'], 'zh-TW': ['事件'], ja: ['イベント'], ko: ['이벤트'], vi: ['sự kiện'], th: ['เหตุการณ์'], id: ['peristiwa'], hi: ['घटना', 'घटनाओं', 'घटनाएँ'], ar: ['حدث', 'الحدث', 'أحداث', 'الأحداث'] },
    pin: /\bevents?\b/i
  },
  {
    en: 'opportunity',
    sense: 'an event or a forecast worth a look',
    forms: { 'zh-CN': ['机会'], 'zh-TW': ['機會'], ja: ['チャンス'], ko: ['기회'], vi: ['cơ hội'], th: ['โอกาส'], id: ['peluang'], hi: ['अवसर'], ar: ['فرصة', 'الفرصة', 'فرص', 'الفرص'] },
    pin: /opportunit/i
  },
  {
    en: 'model',
    sense: 'an AI model asked through OpenRouter, or one of the forecast\'s own',
    forms: { 'zh-CN': ['模型'], 'zh-TW': ['模型'], ja: ['モデル'], ko: ['모델'], vi: ['mô hình'], th: ['โมเดล'], id: ['model'], hi: ['मॉडल'], ar: ['نموذج', 'النموذج', 'نماذج', 'النماذج'] },
    pin: /\bmodels?\b/i
  },
  {
    en: 'the watch',
    sense: 'the feature that puts each event to the models by itself while it is on',
    forms: { 'zh-CN': ['盯盘'], 'zh-TW': ['盯盤'], ja: ['ウォッチ'], ko: ['워치'], vi: ['theo dõi'], th: ['เฝ้าตลาด'], id: ['pantauan'], hi: ['वॉच'], ar: ['الرصد', 'رصد'] },
    // Not the scanner's "watch" band, which is a level of an event, not this feature.
    pin: /\bthe watch\b(?! band)|\bwatch's\b/i
  },
  {
    en: 'scanner',
    sense: 'what reads the pairs once a minute and raises what moves unusually',
    forms: { 'zh-CN': ['扫描器'], 'zh-TW': ['掃描器'], ja: ['スキャナー'], ko: ['스캐너'], vi: ['trình quét'], th: ['ตัวสแกน'], id: ['pemindai'], hi: ['स्कैनर'], ar: ['الماسح', 'ماسح'] },
    pin: /scanner/i
  },
  {
    en: 'exit check',
    sense: "the AI addition that may close the app's own paper trades early",
    forms: { 'zh-CN': ['离场检查'], 'zh-TW': ['出場檢查'], ja: ['決済チェック'], ko: ['청산 점검'], vi: ['kiểm tra thoát lệnh'], th: ['การตรวจจุดออก'], id: ['pemeriksaan keluar'], hi: ['एग्ज़िट जाँच'], ar: ['فحص الخروج'] },
    pin: /exit check/i
  },
  {
    en: 'budget',
    sense: 'the most the AI calls may cost in a UTC day',
    forms: { 'zh-CN': ['预算'], 'zh-TW': ['預算'], ja: ['予算'], ko: ['예산'], vi: ['ngân sách'], th: ['งบประมาณ'], id: ['anggaran'], hi: ['बजट'], ar: ['ميزانية', 'الميزانية'] },
    pin: /budget/i
  },
  // ---------------------------------------------------------------- what stops and what is told
  {
    en: 'delisting',
    sense: 'Binance removing a coin from trading',
    forms: { 'zh-CN': ['下架'], 'zh-TW': ['下架'], ja: ['上場廃止'], ko: ['상장 폐지'], vi: ['hủy niêm yết'], th: ['เพิกถอน'], id: ['delisting'], hi: ['डीलिस्ट'], ar: ['شطب', 'الشطب'] },
    pin: /delist/i
  },
  {
    en: 'Monitoring Tag',
    sense: "Binance's mark on a coin at risk of delisting",
    forms: { 'zh-CN': ['监控标签'], 'zh-TW': ['監控標籤'], ja: ['モニタリングタグ'], ko: ['모니터링 태그'], vi: ['Nhãn Giám sát'], th: ['แท็กเฝ้าระวัง'], id: ['Tag Pemantauan'], hi: ['मॉनिटरिंग टैग'], ar: ['علامة المراقبة'] },
    pin: /Monitoring Tag/
  },
  {
    en: 'kill switch',
    sense: 'what blocks every new real order until it is released',
    forms: { 'zh-CN': ['紧急停止开关'], 'zh-TW': ['緊急停止開關'], ja: ['キルスイッチ'], ko: ['킬 스위치'], vi: ['công tắc khẩn cấp'], th: ['สวิตช์หยุดฉุกเฉิน'], id: ['tombol darurat'], hi: ['किल स्विच'], ar: ['مفتاح الإيقاف الطارئ'] },
    pin: /kill switch/i
  },
  {
    en: 'circuit breaker',
    sense: 'a limit that, once reached, stops something for the day',
    forms: { 'zh-CN': ['熔断'], 'zh-TW': ['熔斷'], ja: ['サーキットブレーカー'], ko: ['서킷 브레이커'], vi: ['cầu dao ngắt'], th: ['ระบบตัดวงจร'], id: ['pemutus sirkuit'], hi: ['सर्किट ब्रेकर'], ar: ['قاطع الدائرة'] },
    pin: /circuit breaker/i
  },
  // ---------------------------------------------------------------- the pages, as the sidebar names them
  {
    en: 'Home',
    sense: 'the page',
    forms: { 'zh-CN': ['首页'], 'zh-TW': ['首頁'], ja: ['ホーム'], ko: ['홈'], vi: ['Trang chủ'], th: ['หน้าแรก'], id: ['Beranda'], hi: ['होम'], ar: ['الرئيسية'] },
    pin: /\bHome\b/
  },
  {
    en: 'Predictions',
    sense: 'the page',
    forms: { 'zh-CN': ['预测'], 'zh-TW': ['預測'], ja: ['予測'], ko: ['예측'], vi: ['Dự đoán'], th: ['การทำนาย'], id: ['Prediksi'], hi: ['भविष्यवाणियाँ'], ar: ['التنبؤات'] },
    pin: /\bPredictions\b/
  },
  {
    en: 'Opportunities',
    sense: 'the page',
    forms: { 'zh-CN': ['机会'], 'zh-TW': ['機會'], ja: ['チャンス'], ko: ['기회'], vi: ['Cơ hội'], th: ['โอกาส'], id: ['Peluang'], hi: ['अवसर'], ar: ['الفرص'] },
    pin: /\bOpportunities\b/
  },
  {
    en: 'Positions',
    sense: 'the page',
    forms: { 'zh-CN': ['持仓'], 'zh-TW': ['持倉'], ja: ['ポジション'], ko: ['포지션'], vi: ['Vị thế'], th: ['การถือครอง'], id: ['Posisi'], hi: ['पोज़िशन'], ar: ['المراكز'] },
    pin: /\bPositions\b/
  },
  {
    en: 'Performance',
    sense: 'the page',
    forms: { 'zh-CN': ['业绩'], 'zh-TW': ['績效'], ja: ['パフォーマンス'], ko: ['성과'], vi: ['Hiệu suất'], th: ['ผลงาน'], id: ['Kinerja'], hi: ['प्रदर्शन'], ar: ['الأداء'] },
    pin: /\bPerformance\b/
  },
  {
    en: 'Strategies › Execution',
    sense: 'the page, at its view of what is running',
    forms: { 'zh-CN': ['策略 › 执行'], 'zh-TW': ['策略 › 執行'], ja: ['戦略 › 執行'], ko: ['전략 › 실행'], vi: ['Chiến lược › Thực thi'], th: ['กลยุทธ์ › การดำเนินการ'], id: ['Strategi › Eksekusi'], hi: ['रणनीतियाँ › निष्पादन'], ar: ['الاستراتيجيات › التنفيذ'] },
    pin: /Strategies › Execution/
  },
  {
    en: 'Risk & Safety',
    sense: 'the page',
    forms: { 'zh-CN': ['风险与安全'], 'zh-TW': ['風險與安全'], ja: ['リスクと安全'], ko: ['위험 및 안전'], vi: ['Rủi ro & An toàn'], th: ['ความเสี่ยงและความปลอดภัย'], id: ['Risiko & Keamanan'], hi: ['जोखिम और सुरक्षा'], ar: ['المخاطر والأمان'] },
    pin: /Risk & Safety/
  },
  {
    en: 'Connections',
    sense: 'the page',
    forms: { 'zh-CN': ['连接'], 'zh-TW': ['連線'], ja: ['接続'], ko: ['연결'], vi: ['Kết nối'], th: ['การเชื่อมต่อ'], id: ['Koneksi'], hi: ['कनेक्शन'], ar: ['الاتصالات'] },
    pin: /\bConnections\b/
  },
  {
    en: 'Settings',
    sense: 'the page',
    forms: { 'zh-CN': ['设置'], 'zh-TW': ['設定'], ja: ['設定'], ko: ['설정'], vi: ['Cài đặt'], th: ['การตั้งค่า'], id: ['Pengaturan'], hi: ['सेटिंग्स'], ar: ['الإعدادات'] },
    pin: /\bSettings\b/
  }
]
