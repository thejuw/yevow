"""Local midnight scheduler fallback for the Congressional Tracker runner."""

from __future__ import annotations

import asyncio
import logging
import time

import schedule

from .pipeline import CongressETLPipeline


def run_daily_job() -> None:
    logging.getLogger("CongressScheduler").info("Starting scheduled Congressional Tracker job.")
    asyncio.run(CongressETLPipeline().run())


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    schedule.every().day.at("00:00").do(run_daily_job)

    while True:
        schedule.run_pending()
        time.sleep(30)


if __name__ == "__main__":
    main()
