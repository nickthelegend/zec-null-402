//! zpay-verify CLI.
//!
//!     zpay-verify verify <txid> --amount <zat> [--memo <text>] [--min-conf <n>] [--allow-transparent]
//!         prints {"report":…,"verdict":…,"lightwalletd":…}; exit 0 = paid, 1 = not paid, 2 = could not check
//!     zpay-verify inspect <txid>...    one JSON report per line (what the key sees, no rules)
//!     zpay-verify derive               UIVK for the UFVK in ZPV_UFVK
//!     zpay-verify tip                  current chain height from lightwalletd
//!
//! The key comes from ZPV_UIVK (environment only, never an argument, so it stays out of shell
//! history and process lists). Lightwalletd: ZPV_LWD_URL, default https://testnet.zec.rocks:443.

use zpay_verify::{inspect, lwd, parse_uivk, uivk_from_ufvk, verify, Expect};

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
env:   ZPV_UIVK (verify, inspect), ZPV_UFVK (derive), ZPV_LWD_URL (default https://testnet.zec.rocks:443)";

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
        Some("tip") => {
            let mut c = lwd::connect(&lwd_url()).await.unwrap_or_else(|err| fail(2, err));
            println!("{}", u32::from(lwd::chain_tip(&mut c).await.unwrap_or_else(|err| fail(2, err))));
        }
        Some("derive") => println!("{}", uivk_from_ufvk(&env("ZPV_UFVK")).unwrap_or_else(|err| fail(2, err))),
        _ => fail(2, USAGE),
    }
}
