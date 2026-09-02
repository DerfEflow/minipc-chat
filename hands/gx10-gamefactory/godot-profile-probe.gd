extends SceneTree

func stop(code: int) -> void:
	quit(code)

func read_text(path: String) -> String:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return ""
	return file.get_as_text()

func write_text(path: String, value: String) -> bool:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(value)
	file.flush()
	return true

func readable(path: String) -> bool:
	return FileAccess.open(path, FileAccess.READ) != null or DirAccess.open(path) != null

func _init() -> void:
	var user_args := OS.get_cmdline_user_args()
	if user_args.size() != 1 or not user_args[0].is_valid_identifier():
		stop(70)
		return
	var nonce: String = user_args[0]
	var prefix := ".dominion-probe-%s" % nonce
	for path in ["/commands", "/replies", "/app", "/proc/self/status", "/proc/self/attr/current", "/proc/self/maps"]:
		if readable(path):
			stop(71)
			return
	var peers_value = JSON.parse_string(read_text(prefix + "-peers"))
	if not peers_value is Array or not peers_value.has(1):
		stop(72)
		return
	for raw_pid in peers_value:
		var pid := int(raw_pid)
		for suffix in ["environ", "cmdline", "root", "cwd", "fd", "mem", "maps"]:
			if readable("/proc/%d/%s" % [pid, suffix]):
				stop(73)
				return
		if OS.is_process_running(pid):
			stop(74)
			return
	if OS.get_environment("HOME") != "/runtime/payload" or OS.get_environment("TMPDIR") != "/runtime/payload/tmp":
		stop(75)
		return
	if OS.get_environment("XDG_CONFIG_HOME") != "/runtime/payload/config" or OS.get_environment("XDG_CACHE_HOME") != "/runtime/payload/cache" or OS.get_environment("XDG_DATA_HOME") != "/runtime/payload/data":
		stop(76)
		return
	if not write_text(prefix + "-godot-workspace", "workspace-write-ok\n") or not write_text("/runtime/payload/%s-godot-runtime" % prefix, "runtime-write-ok\n"):
		stop(77)
		return
	var socket := StreamPeerTCP.new()
	if socket.connect_to_host("198.51.100.1", 9) == OK:
		stop(78)
		return
	if not write_text("/runtime/payload/%s-godot-ready" % prefix, "ready\n"):
		stop(79)
		return
	OS.delay_msec(750)
	stop(0)
