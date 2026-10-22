//! zpay-verify CLI.
//!
//!     zpay-verify verify <txid> --amount <zat> [--memo <text>] [--min-conf <n>] [--allow-transparent]
//!         prints {"report":…,"verdict":…,"lightwalletd":…}; exit 0 = paid, 1 = not paid, 2 = could not check
//!     zpay-verify inspect <txid>...    one JSON report per line (what the key sees, no rules)
//!     zpay-verify derive               UIVK for the UFVK in ZPV_UFVK
//!     zpay-verify tip                  current chain height from lightwalletd
//!     zpay-verify scan-range <from> [to] | scan-range --last <n>
//!         every transaction in blocks from..=to (to defaults to the tip; --last: the n blocks ending at
//!         the tip) with an output to the key (compact-block trial decryption of Sapling, Orchard and
//!         Ironwood outputs), each re-read in full: {"from","to","blocks","tip","txs":[report…]}
//!
//! The key comes from ZPV_UIVK (environment only, never an argument, so it stays out of shell
//! history and process lists). Lightwalletd: ZPV_LWD_URL, default https://testnet.zec.rocks:443.

use zcash_protocol::consensus::BlockHeight;
use zpay_verify::{inspect, lwd, parse_uivk, scan_range, uivk_from_ufvk, verify, Expect};

fn fail(code: i32, msg: impl std::fmt::Display) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(code)
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| fail(2, format!("Setup required: {name}")))
}

fn lwd_url() -> String {
    std::env::var("ZPV_LWD_URL").unwrap_or_else(|_| lwd::DEFAULT_LWD_URL.to_string())
}

const USAGE: &str = "usage: zpay-verify verify <txid> --amount <zat> [--memo <text>] [--min-conf <n>] [--allow-transparent]
       zpay-verify inspect <txid>...
       zpay-verify derive
       zpay-verify tip
       zpay-verify scan-range <from> [to] | zpay-verify scan-range --last <n>
env:   ZPV_UIVK (verify, inspect, scan-range), ZPV_UFVK (derive), ZPV_LWD_URL (default https://testnet.zec.rocks:443)";

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("verify") => {
            let txid = args.get(1).filter(|a| !a.starts_with("--")).unwrap_or_else(|| fail(2, USAGE));
            let mut e = Expect { amount_zat: 0, memo: None, min_conf: 1, shielded_only: true };
            let mut amount = None;
            let mut i = 2;
            while i < args.len() {
                let val = || args.get(i + 1).cloned().unwrap_or_else(|| fail(2, format!("{} needs a value", args[i])));
                match args[i].as_str() {
                    "--amount" => amount = Some(val().parse::<u64>().unwrap_or_else(|_| fail(2, "--amount must be zatoshis (a whole number)"))),
                    "--memo" => e.memo = Some(val()),
                    "--min-conf" => e.min_conf = val().parse().unwrap_or_else(|_| fail(2, "--min-conf must be a whole number")),
                    "--allow-transparent" => {
                        e.shielded_only = false;
                        i += 1;
                        continue;
                    }
                    other => fail(2, format!("unknown option {other}\n{USAGE}")),
                }
                i += 2;
            }
            e.amount_zat = amount.unwrap_or_else(|| fail(2, "--amount is required"));
            let v = verify(&lwd_url(), &env("ZPV_UIVK"), txid, &e).await.unwrap_or_else(|err| fail(2, err));
            println!("{}", serde_json::to_string(&v).expect("serializable"));
            std::process::exit(if v.verdict.ok { 0 } else { 1 });
        }
        Some("inspect") if args.len() > 1 => {
            let key = parse_uivk(&env("ZPV_UIVK")).unwrap_or_else(|err| fail(2, err));
            let url = lwd_url();
            let mut c = lwd::connect(&url).await.unwrap_or_else(|err| fail(2, err));
            let tip = lwd::chain_tip(&mut c).await.unwrap_or_else(|err| fail(2, err));
            for txid in &args[1..] {
                let r = inspect(&mut c, &key, txid, tip).await.unwrap_or_else(|err| fail(2, err));
                println!("{}", serde_json::to_string(&r).expect("serializable"));
            }
        }
        Some("scan-range") if args.len() == 2 || args.len() == 3 => {
            let key = parse_uivk(&env("ZPV_UIVK")).unwrap_or_else(|err| fail(2, err));
            let height = |s: &str| s.parse::<u64>().unwrap_or_else(|_| fail(2, format!("scan-range: {s} is not a block height")));
            let mut c = lwd::connect(&lwd_url()).await.unwrap_or_else(|err| fail(2, err));
            let tip = u64::from(u32::from(lwd::chain_tip(&mut c).await.unwrap_or_else(|err| fail(2, err))));
            // <from> [to] (to defaults to the tip), or --last <n>: the n blocks ending at the tip
            let (from, to) = if args[1] == "--last" {
                let n = height(args.get(2).map(String::as_str).unwrap_or_else(|| fail(2, "scan-range --last <n>")));
                (tip.saturating_sub(n.max(1) - 1), tip)
            } else {
                (height(&args[1]), args.get(2).map(|s| height(s)).unwrap_or(tip).min(tip))
            };
            if to >= from && to - from >= 200_000 {
                fail(2, "scan-range: at most 200,000 blocks at once");
            }
            let (hits, blocks) = if from > to { (vec![], 0) } else { scan_range(&mut c, &key, from, to).await.unwrap_or_else(|err| fail(2, err)) };
            let mut txids: Vec<String> = hits.iter().map(|h| h.txid.clone()).collect();
            txids.sort();
            txids.dedup();
            let mut txs = Vec::new();
            for t in &txids {
                txs.push(inspect(&mut c, &key, t, BlockHeight::from_u32(tip as u32)).await.unwrap_or_else(|err| fail(2, err)));
            }
            println!("{}", serde_json::json!({ "from": from, "to": to, "blocks": blocks, "tip": tip, "txs": txs }));
        }
        Some("tip") => {
            let mut c = lwd::connect(&lwd_url()).await.unwrap_or_else(|err| fail(2, err));
            println!("{}", u32::from(lwd::chain_tip(&mut c).await.unwrap_or_else(|err| fail(2, err))));
        }
        Some("derive") => println!("{}", uivk_from_ufvk(&env("ZPV_UFVK")).unwrap_or_else(|err| fail(2, err))),
        _ => fail(2, USAGE),
    }
}
