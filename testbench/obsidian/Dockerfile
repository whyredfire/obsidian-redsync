FROM lscr.io/linuxserver/obsidian:latest
RUN apt-get update && apt-get install -y --no-install-recommends socat && rm -rf /var/lib/apt/lists/*
COPY root/ /
RUN chmod +x /usr/bin/obsidian /custom-cont-init.d/* /custom-services.d/*
