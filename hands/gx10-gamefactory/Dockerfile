# syntax=docker/dockerfile:1
# Web/QA-only two-service lane. There is deliberately no Android SDK or license layer.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:e9b5516b06baeaea9a8e65a7aec6a85fbb960a30b52b66968f2c8092b3e2a3eb

FROM ${NODE_IMAGE} AS sandbox-builder
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential file libcap2-bin libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
COPY hands/gx10-gamefactory/fd-launcher.c /tmp/fd-launcher.c
COPY hands/gx10-gamefactory/generate-child-seccomp.c /tmp/generate-child-seccomp.c
RUN gcc -O2 -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -Wall -Wextra -Werror \
      /tmp/fd-launcher.c -Wl,-z,relro,-z,now,-z,noexecstack -static-pie -o /tmp/fd-launcher \
    && gcc -O2 -Wall -Wextra -Werror /tmp/generate-child-seccomp.c -lseccomp -o /tmp/generate-child-seccomp \
    && mkdir -p /out/opt/dominion-sandbox \
    && install -o root -g root -m 0555 /tmp/fd-launcher /out/opt/dominion-sandbox/fd-launcher \
    && /tmp/generate-child-seccomp node /out/opt/dominion-sandbox/node-seccomp.bpf \
    && /tmp/generate-child-seccomp godot /out/opt/dominion-sandbox/godot-seccomp.bpf \
    && chown root:root /out/opt/dominion-sandbox/*.bpf \
    && chmod 0444 /out/opt/dominion-sandbox/*.bpf \
    && test "$(stat -c %u:%g:%a:%h /out/opt/dominion-sandbox/fd-launcher)" = 0:0:555:1 \
    && test "$(stat -c %u:%g:%a:%h /out/opt/dominion-sandbox/node-seccomp.bpf)" = 0:0:444:1 \
    && test "$(stat -c %u:%g:%a:%h /out/opt/dominion-sandbox/godot-seccomp.bpf)" = 0:0:444:1 \
    && test -z "$(getcap /out/opt/dominion-sandbox/fd-launcher /out/opt/dominion-sandbox/*.bpf)" \
    && file /out/opt/dominion-sandbox/fd-launcher | grep -q 'static-pie linked' \
    && ! readelf -lW /out/opt/dominion-sandbox/fd-launcher | grep -q ' INTERP ' \
    && ! readelf -dW /out/opt/dominion-sandbox/fd-launcher | grep -q ' NEEDED '

FROM ${NODE_IMAGE} AS controller
USER root
RUN groupadd --gid 11000 dominion-spool \
    && groupadd --gid 10001 dominion-controller \
    && useradd --uid 10001 --gid 10001 --groups 11000 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin dominion-controller \
    && mkdir -p /app /broker-requests /broker-results \
    && chown 10001:11000 /broker-requests \
    && chown 10003:11000 /broker-results \
    && chmod 0555 /app \
    && chmod 2750 /broker-requests /broker-results
COPY hands/hands.mjs hands/snapshot.mjs hands/gx10-controller-entrypoint.mjs \
     hands/gamefactory-broker-controller.mjs hands/gamefactory-broker-protocol.mjs \
     hands/gamefactory-broker-projects.mjs hands/gamefactory-ipc.mjs /app/
RUN chmod 0444 /app/*.mjs && chmod 0555 /app
LABEL org.opencontainers.image.title="Dominion GX10 Game Factory Controller" \
      org.opencontainers.image.role="token-bearing-controller-no-build-toolchain"
ENV NODE_ENV=production
USER 10001:10001
WORKDIR /app
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/gx10-controller-entrypoint.mjs"]

# Retained only as inert build history. Production compose has no target/reference to this stage.
FROM ${NODE_IMAGE} AS retired_executor_inert
ARG GODOT_VERSION=4.7.2
ARG GODOT_SHA512=dd59918da086bd49bde2f5450b5e567ff8650cbde9abbd7b8f4ca1197ff8c609baa38834666d032deafb47099078d7822279e2a0e06e5665745468f26533e7e2
ARG GODOT_TEMPLATES_SHA512=ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl fontconfig libcap2-bin unzip util-linux \
       libasound2 libdbus-1-3 libfontconfig1 libgl1 libpulse0 libudev1 \
       libwayland-client0 libwayland-cursor0 libwayland-egl1 \
       libx11-6 libxcursor1 libxi6 libxinerama1 libxrandr2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-builder /out/opt/dominion-sandbox /opt/dominion-sandbox
RUN mkdir -p /opt/dominion-payload \
    && cp --reflink=never "$(readlink -f "$(command -v node)")" /opt/dominion-payload/node \
    && chown root:root /opt/dominion-payload/node \
    && chmod 0555 /opt/dominion-payload/node
RUN curl -fL --retry 4 --proto '=https' --tlsv1.2 \
      "https://godot-releases.nbg1.your-objectstorage.com/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.arm64.zip" -o /tmp/godot.zip \
    && echo "${GODOT_SHA512}  /tmp/godot.zip" | sha512sum -c - \
    && unzip -qp /tmp/godot.zip "Godot_v${GODOT_VERSION}-stable_linux.arm64" > /opt/dominion-payload/godot \
    && chown root:root /opt/dominion-payload/godot \
    && chmod 0555 /opt/dominion-payload/godot \
    && rm /tmp/godot.zip
RUN curl -fL --retry 4 --proto '=https' --tlsv1.2 \
      "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_export_templates.tpz" -o /tmp/godot-templates.tpz \
    && echo "${GODOT_TEMPLATES_SHA512}  /tmp/godot-templates.tpz" | sha512sum -c - \
    && mkdir -p /tmp/godot-templates "/opt/dominion-payload/editor_data/export_templates/${GODOT_VERSION}.stable" \
    && unzip -q /tmp/godot-templates.tpz -d /tmp/godot-templates \
    && cp -a /tmp/godot-templates/templates/. "/opt/dominion-payload/editor_data/export_templates/${GODOT_VERSION}.stable/" \
    && install -o root -g root -m 0444 /dev/null /opt/dominion-payload/_sc_ \
    && rm -rf /tmp/godot-templates /tmp/godot-templates.tpz \
    && chown -R root:root /opt/dominion-payload \
    && chmod -R a-w /opt/dominion-payload \
    && find /opt/dominion-payload -type d -exec chmod 0555 {} + \
    && find /opt/dominion-payload -type f ! -name node ! -name godot -exec chmod 0444 {} + \
    && test "$(stat -c %u:%g:%a:%h /opt/dominion-payload/node)" = 0:0:555:1 \
    && test "$(stat -c %u:%g:%a:%h /opt/dominion-payload/godot)" = 0:0:555:1 \
    && test -z "$(getcap /opt/dominion-payload/node /opt/dominion-payload/godot /opt/dominion-sandbox/fd-launcher)"
RUN groupadd --gid 11000 dominion-spool \
    && groupadd --gid 10002 dominion-executor \
    && useradd --uid 10002 --gid 10002 --groups 11000 --no-create-home --home-dir /runtime/payload --shell /usr/sbin/nologin dominion-executor \
    && mkdir -p /app /commands /replies /workspace /runtime /policy \
    && chmod 0555 /policy \
    && chown -R 10002:10002 /replies /workspace /runtime
COPY hands/gamefactory-worker.mjs hands/gamefactory-executor.mjs hands/gamefactory-ipc.mjs hands/gx10-executor-entrypoint.mjs /app/
COPY hands/gx10-gamefactory/toolchain-attestation.mjs /opt/dominion-canary/toolchain-attestation.mjs
COPY hands/gx10-gamefactory/godot-profile-probe.gd /opt/dominion-canary/godot-profile-probe.gd
RUN chmod 0444 /app/*.mjs /opt/dominion-canary/toolchain-attestation.mjs /opt/dominion-canary/godot-profile-probe.gd \
    && chmod 0555 /app /opt/dominion-canary /opt/dominion-sandbox \
    && chmod -R a-w /app /opt/dominion-canary /opt/dominion-sandbox \
    && apt-get purge -y libcap2-bin \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
LABEL org.opencontainers.image.title="Dominion Web Game Factory GX10 Executor" \
      org.opencontainers.image.version="fd-launcher-1_godot-4.7.2_web-only" \
      org.opencontainers.image.role="tokenless-networkless-executor" \
      org.opencontainers.image.android-capability="disabled-human-license-material-required"
ENV NODE_ENV=production
USER 10002:10002
WORKDIR /workspace
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/app/gx10-executor-entrypoint.mjs"]

# The production broker payload assembly downloads only the pinned Web/Godot artifacts. There is
# deliberately no Android SDK, license acceptance, Java, Gradle, signing material, or publisher.
FROM ${NODE_IMAGE} AS broker-payload
ARG GODOT_VERSION=4.7.2
ARG GODOT_SHA512=dd59918da086bd49bde2f5450b5e567ff8650cbde9abbd7b8f4ca1197ff8c609baa38834666d032deafb47099078d7822279e2a0e06e5665745468f26533e7e2
ARG GODOT_TEMPLATES_SHA512=ca4d71c4d7b81dfc15d1a98baa07534aa95b03fdda78a0075b06672e1648d2e5f40980c9adc28d23e1b92e732ee7bf3461997aa804af74ec2fcd7a93ccb84079
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/dominion-payload \
    && cp --reflink=never "$(readlink -f "$(command -v node)")" /opt/dominion-payload/node \
    && curl -fL --retry 4 --proto '=https' --tlsv1.2 \
      "https://godot-releases.nbg1.your-objectstorage.com/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.arm64.zip" -o /tmp/godot.zip \
    && echo "${GODOT_SHA512}  /tmp/godot.zip" | sha512sum -c - \
    && unzip -qp /tmp/godot.zip "Godot_v${GODOT_VERSION}-stable_linux.arm64" > /opt/dominion-payload/godot \
    && curl -fL --retry 4 --proto '=https' --tlsv1.2 \
      "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_export_templates.tpz" -o /tmp/godot-templates.tpz \
    && echo "${GODOT_TEMPLATES_SHA512}  /tmp/godot-templates.tpz" | sha512sum -c - \
    && mkdir -p /tmp/godot-templates "/opt/dominion-payload/editor_data/export_templates/${GODOT_VERSION}.stable" \
    && unzip -q /tmp/godot-templates.tpz -d /tmp/godot-templates \
    && cp -a /tmp/godot-templates/templates/. "/opt/dominion-payload/editor_data/export_templates/${GODOT_VERSION}.stable/" \
    && install -o root -g root -m 0444 /dev/null /opt/dominion-payload/_sc_ \
    && chown -R root:root /opt/dominion-payload \
    && find /opt/dominion-payload -type d -exec chmod 0555 {} + \
    && find /opt/dominion-payload -type f -exec chmod 0444 {} + \
    && chmod 0555 /opt/dominion-payload/node /opt/dominion-payload/godot

FROM ${NODE_IMAGE} AS broker-builder
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential file libcap2-bin libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=broker-payload /opt/dominion-payload /opt/dominion-payload
COPY hands/gx10-gamefactory/fd-launcher.c hands/gx10-gamefactory/launch-broker.c \
     hands/gx10-gamefactory/payload-guard.c hands/gx10-gamefactory/generate-child-seccomp.c /tmp/build/
RUN mkdir -p /out/opt/dominion-broker /out/opt/dominion-payload \
    && cp -a /opt/dominion-payload/. /out/opt/dominion-payload/ \
    && gcc -O2 -Wall -Wextra -Werror /tmp/build/generate-child-seccomp.c -lseccomp -o /tmp/generate-child-seccomp \
    && /tmp/generate-child-seccomp node /out/opt/dominion-broker/node-seccomp.bpf \
    && /tmp/generate-child-seccomp godot /out/opt/dominion-broker/godot-seccomp.bpf \
    && node_sha="$(sha256sum /out/opt/dominion-payload/node | cut -d' ' -f1)" \
    && godot_sha="$(sha256sum /out/opt/dominion-payload/godot | cut -d' ' -f1)" \
    && node_filter_sha="$(sha256sum /out/opt/dominion-broker/node-seccomp.bpf | cut -d' ' -f1)" \
    && godot_filter_sha="$(sha256sum /out/opt/dominion-broker/godot-seccomp.bpf | cut -d' ' -f1)" \
    && gcc -std=c17 -O2 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -static-pie \
      -DGUARD_PROGRAM_NAME='"node"' -DGUARD_ENGINE_SHA256='"'"$node_sha"'"' \
      -DGUARD_FILTER_SHA256='"'"$node_filter_sha"'"' /tmp/build/payload-guard.c \
      -Wl,-z,relro,-z,now,-z,noexecstack -o /out/opt/dominion-broker/node-guard \
    && gcc -std=c17 -O2 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -static-pie \
      -DGUARD_PROGRAM_NAME='"godot"' -DGUARD_ENGINE_SHA256='"'"$godot_sha"'"' \
      -DGUARD_FILTER_SHA256='"'"$godot_filter_sha"'"' /tmp/build/payload-guard.c \
      -Wl,-z,relro,-z,now,-z,noexecstack -o /out/opt/dominion-broker/godot-guard \
    && gcc -std=c17 -O2 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 \
      -DFD_LAUNCHER_ENTRY=payload_launch_entry \
      -c /tmp/build/fd-launcher.c -o /tmp/fd-launcher.o \
    && gcc -std=c17 -O2 -Wall -Wextra -Werror -fPIE -fstack-protector-strong -D_FORTIFY_SOURCE=3 -static-pie \
      /tmp/build/launch-broker.c /tmp/fd-launcher.o -Wl,-z,relro,-z,now,-z,noexecstack \
      -o /out/opt/dominion-broker/launch-broker \
    && mkdir -p /out/opt/dominion-broker/guards \
    && for slug in system-canary vector-vault bolt-bloom pocket-gravity chromalock tiny-foundry letter-loom pulse-path shelf-shift wobble-works signal-grid; do \
         cp --reflink=never /out/opt/dominion-broker/node-guard "/out/opt/dominion-broker/guards/${slug}-node-guard"; \
         cp --reflink=never /out/opt/dominion-broker/godot-guard "/out/opt/dominion-broker/guards/${slug}-godot-guard"; \
       done \
    && chown -R root:root /out/opt/dominion-broker /out/opt/dominion-payload \
    && chmod 0555 /out/opt/dominion-broker/launch-broker /out/opt/dominion-broker/node-guard /out/opt/dominion-broker/godot-guard /out/opt/dominion-broker/guards/* \
    && chmod 0444 /out/opt/dominion-broker/*.bpf \
    && test -z "$(getcap -r /out/opt/dominion-broker /out/opt/dominion-payload 2>/dev/null)" \
    && for binary in /out/opt/dominion-broker/launch-broker /out/opt/dominion-broker/node-guard /out/opt/dominion-broker/godot-guard /out/opt/dominion-broker/guards/*; do \
         file "$binary" | grep -q 'static-pie linked'; \
         ! readelf -lW "$binary" | grep -q ' INTERP '; \
         ! readelf -dW "$binary" | grep -q ' NEEDED '; \
       done

FROM ${NODE_IMAGE} AS broker
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates fontconfig libasound2 libdbus-1-3 libfontconfig1 libgl1 libpulse0 libudev1 \
       libwayland-client0 libwayland-cursor0 libwayland-egl1 libx11-6 libxcursor1 libxi6 libxinerama1 libxrandr2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 11000 dominion-spool \
    && groupadd --gid 10003 dominion-broker \
    && useradd --uid 10003 --gid 10003 --groups 11000 --no-create-home --home-dir /runtime/payload --shell /usr/sbin/nologin dominion-broker \
    && mkdir -p /broker-requests /broker-results /broker-state /workspace /runtime /opt/dominion-policy \
    && chmod 0555 /opt/dominion-policy
COPY --from=broker-builder /out/opt/dominion-broker /opt/dominion-broker
COPY --from=broker-builder /out/opt/dominion-payload /opt/dominion-payload
COPY hands/gx10-gamefactory/dominion-gx10-gamefactory-broker.apparmor \
     hands/gx10-gamefactory/seccomp-gx10-gamefactory-broker.json \
     hands/gx10-gamefactory/gamefactory-broker-policy.bin /opt/dominion-policy/
RUN chown -R root:root /opt/dominion-broker /opt/dominion-payload /opt/dominion-policy \
    && chmod -R a-w /opt/dominion-broker /opt/dominion-payload /opt/dominion-policy \
    && chmod 0444 /opt/dominion-policy/* \
    && test -z "$(command -v curl || true)" \
    && test -z "$(command -v unzip || true)" \
    && test -z "$(command -v java || true)" \
    && test -z "$(command -v gradle || true)" \
    && test ! -d /opt/android-sdk
LABEL org.opencontainers.image.title="Dominion GX10 Web Game Factory Static Broker" \
      org.opencontainers.image.role="tokenless-networkless-static-broker-pid1" \
      org.opencontainers.image.android-capability="disabled-human-license-material-required"
USER 10003:10003
WORKDIR /workspace
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/dominion-broker/launch-broker"]
