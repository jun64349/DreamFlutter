import csv
import hashlib
import random
import shutil
import statistics
import sys
from pathlib import Path


def simulate(arrival_rate, service_rate, seed, warmup, count):
    rng = random.Random(seed)
    arrival = departure = 0.0
    waits = []
    for index in range(warmup + count):
        arrival += rng.expovariate(arrival_rate)
        start = max(arrival, departure)
        departure = start + rng.expovariate(service_rate)
        if index >= warmup:
            waits.append(start - arrival)
    ordered = sorted(waits)
    return statistics.fmean(waits), ordered[(95 * count + 99) // 100 - 1]


def main(theory, parameters, output):
    output.mkdir(parents=True, exist_ok=True)
    reference = theory.read_text(encoding="utf-8")
    if "Q-THEORY-1" not in reference or "Wq = ρ / (μ - λ)" not in reference:
        raise ValueError("Missing or inconsistent queue theory source")
    sources = [(theory, "queue-theory.md", "Q-THEORY-1"),
               (parameters, "queue-operating-sample.csv", "Q-OPERATIONS-1")]
    source_lines = []
    for path, filename, source in sources:
        shutil.copyfile(path, output / filename)
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        source_lines.append(f"- [{source}]({filename})，SHA-256 `{checksum}`")

    warmup, count = 10000, 120000
    rows = []
    with parameters.open(encoding="utf-8", newline="") as handle:
        for index, item in enumerate(csv.DictReader(handle)):
            arrival = float(item["arrival_per_minute"])
            service = float(item["service_per_minute"])
            if item["source_id"] != "Q-OPERATIONS-1" or not 0 < arrival < service:
                raise ValueError(f"Invalid operating parameters for {item['scenario']}")
            seed = 20261120 + index
            average, p95 = simulate(arrival, service, seed, warmup, count)
            expected = arrival / service / (service - arrival)
            rows.append((item["scenario"], arrival, service, seed, warmup, count,
                         f"{expected:.5f}", f"{average:.5f}", f"{p95:.5f}",
                         f"{abs(average / expected - 1):.5f}"))

    with (output / "queue-results.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["scenario", "arrival_per_minute", "service_per_minute", "seed", "warmup",
                         "samples", "theory_mean_min", "simulated_mean_min", "simulated_p95_min", "relative_error"])
        writer.writerows(rows)

    report = ["# 单服务台排队模拟", "", "本次使用两份本地合成材料。参数用于功能验收，无法代表某个实际系统。",
              "", *source_lines, "", "## 模型与误差", "",
              "假设一个服务台、先到先服务，顾客无中途离队。到达间隔和服务时间独立且服从指数分布。",
              "每个情景丢弃前 10,000 个顾客，统计随后 120,000 个顾客的排队等待时间。初始队列为空。",
              "理论值采用 Q-THEORY-1 的稳态平均值。模拟 P95 采用样本最近秩法。等待时间单位为分钟。",
              "", "| 情景 | 理论均值 | 模拟均值 | 模拟 P95 | 相对误差 |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for scenario, _, _, _, _, _, expected, average, p95, error in rows:
        report.append(f"| {scenario} | {expected} | {average} | {p95} | {float(error):.1%} |")
    report.extend(["", "模拟中，负载上升时平均等待和 P95 均增加。该结果仅适用于上述合成参数与模型假设。",
                   "", "结果明细见 [CSV](queue-results.csv)。在交付目录运行以下命令可复现，输出到新目录。",
                   "", "```text", "python queue-simulation.py queue-theory.md queue-operating-sample.csv rerun", "```", ""])
    (output / "queue-report.md").write_text("\n".join(report), encoding="utf-8")
    print(f"Simulated {len(rows)} queue scenarios with {count} retained samples each")


if __name__ == "__main__":
    main(*(Path(arg) for arg in sys.argv[1:]))
