#!/usr/bin/env sh
# Install the latest sana-mcp release:
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.sh | sh
# Pin a release:
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.sh | SANA_MCP_VERSION=v0.4.13 sh
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/download/v0.4.13/install.sh | sh
set -eu
set -f
umask 077

repo="laelhalawani/sana-mcp"
tmp_dir=""
staged_binary=""
staged_receipt=""
staged_path=""
install_lock=""
path_lock=""
install_lock_token=""
path_lock_token=""
install_lock_value=""
path_lock_value=""
install_lock_acquired=0
path_lock_acquired=0
install_lock_created=0
path_lock_created=0
install_lock_token_created=0
path_lock_token_created=0
transaction_active=0
committed=0
old_present=0
old_was_running=0
should_run_after_install=0
path_changed=0
path_existed=0
path_file=""
path_written_sha256=""
path_preimage_sha256=""
dest=""
receipt=""
preserve_tmp=0
config_journal_dir=""
config_journal_file=""
config_transaction_state=none
config_outcome=""
config_authentication=""
retain_new_runtime=0
config_journal_preexisting=0
live_state_touched=0

fail() {
  printf 'sana-mcp: %s\n' "$*" >&2
  exit 1
}

install_lock_is_owned() {
  [ "$install_lock_acquired" = "1" ] &&
    [ -d "$install_lock" ] &&
    [ ! -L "$install_lock" ] &&
    [ -f "$install_lock_token" ] &&
    [ ! -L "$install_lock_token" ] &&
    [ "$(wc -l < "$install_lock_token" | tr -d '[:space:]')" = "1" ] &&
    IFS= read -r observed_install_lock_value < "$install_lock_token" &&
    [ "$observed_install_lock_value" = "$install_lock_value" ]
}

path_lock_is_owned() {
  [ "$path_lock_acquired" = "1" ] &&
    [ -d "$path_lock" ] &&
    [ ! -L "$path_lock" ] &&
    [ -f "$path_lock_token" ] &&
    [ ! -L "$path_lock_token" ] &&
    [ "$(wc -l < "$path_lock_token" | tr -d '[:space:]')" = "1" ] &&
    IFS= read -r observed_path_lock_value < "$path_lock_token" &&
    [ "$observed_path_lock_value" = "$path_lock_value" ]
}

assert_installer_locks_owned() {
  install_lock_is_owned ||
    fail "the sana-mcp install lock was lost before publication"
  path_lock_is_owned ||
    fail "the per-user installer lock was lost before publication"
}

release_install_lock() {
  [ "$install_lock_acquired" = "1" ] || return 0
  install_lock_is_owned || {
    mark_cleanup_lock_ownership_lost
    return 1
  }
  rm -f "$install_lock_token" || return 1
  rmdir "$install_lock" || return 1
  install_lock_acquired=0
  install_lock_token_created=0
  install_lock_created=0
  install_lock_token=""
  install_lock_value=""
  install_lock=""
}

release_path_lock() {
  [ "$path_lock_acquired" = "1" ] || return 0
  path_lock_is_owned || {
    mark_cleanup_lock_ownership_lost
    return 1
  }
  rm -f "$path_lock_token" || return 1
  rmdir "$path_lock" || return 1
  path_lock_acquired=0
  path_lock_token_created=0
  path_lock_created=0
  path_lock_token=""
  path_lock_value=""
  path_lock=""
}

cleanup_unowned_install_lock_artifacts() {
  unowned_install_cleanup_failed=0
  if [ "$install_lock_token_created" = "1" ]; then
    if rm -f "$install_lock_token"; then
      install_lock_token_created=0
      install_lock_token=""
      install_lock_value=""
    else
      unowned_install_cleanup_failed=1
      printf 'sana-mcp: could not remove the unverified install-lock token: %s\n' "$install_lock_token" >&2
    fi
  fi
  if [ "$install_lock_created" = "1" ]; then
    if rmdir "$install_lock"; then
      install_lock_created=0
      install_lock=""
    else
      unowned_install_cleanup_failed=1
      printf 'sana-mcp: could not remove the installer-created install-lock directory: %s\n' "$install_lock" >&2
    fi
  fi
  [ "$unowned_install_cleanup_failed" = "0" ]
}

cleanup_unowned_path_lock_artifacts() {
  unowned_path_cleanup_failed=0
  if [ "$path_lock_token_created" = "1" ]; then
    if rm -f "$path_lock_token"; then
      path_lock_token_created=0
      path_lock_token=""
      path_lock_value=""
    else
      unowned_path_cleanup_failed=1
      printf 'sana-mcp: could not remove the unverified user-state-lock token: %s\n' "$path_lock_token" >&2
    fi
  fi
  if [ "$path_lock_created" = "1" ]; then
    if rmdir "$path_lock"; then
      path_lock_created=0
      path_lock=""
    else
      unowned_path_cleanup_failed=1
      printf 'sana-mcp: could not remove the installer-created user-state-lock directory: %s\n' "$path_lock" >&2
    fi
  fi
  [ "$unowned_path_cleanup_failed" = "0" ]
}

read_config_transaction_result() {
  result_file=$1
  expected_operation=$2
  result_status=$3
  [ -f "$result_file" ] && [ ! -L "$result_file" ] || return 1
  [ "$(wc -l < "$result_file" | tr -d '[:space:]')" = "1" ] || return 1
  parsed_file="$tmp_dir/config-result.parsed"
  SANA_MCP_EXPECTED_JOURNAL=$config_journal_file awk '
    function bad() { exit 2 }
    function string_value(    c, esc, hex) {
      if (substr(line, position, 1) != "\"") bad()
      position++
      parsed = ""
      escaped = 0
      while (position <= length(line)) {
        c = substr(line, position, 1)
        position++
        if (c == "\"") return
        if (c == "\\") {
          escaped = 1
          if (position > length(line)) bad()
          esc = substr(line, position, 1)
          position++
          if (esc == "u") {
            hex = substr(line, position, 4)
            if (length(hex) != 4 ||
                hex !~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/) bad()
            position += 4
          } else if (esc !~ /^["\\\/bfnrt]$/) bad()
          if (esc == "\"") parsed = parsed "\""
          else if (esc == "\\") parsed = parsed "\\"
          else if (esc == "/") parsed = parsed "/"
          else parsed = parsed "?"
        } else {
          if (c ~ /[[:cntrl:]]/) bad()
          parsed = parsed c
        }
      }
      bad()
    }
    function number_value(    c) {
      parsed = ""
      c = substr(line, position, 1)
      if (c == "0") {
        parsed = c
        position++
        if (substr(line, position, 1) ~ /[0-9]/) bad()
        return
      }
      if (c !~ /[1-9]/) bad()
      while (substr(line, position, 1) ~ /[0-9]/) {
        parsed = parsed substr(line, position, 1)
        position++
      }
    }
    NR != 1 { bad() }
    {
      line = $0
      position = 1
      if (substr(line, position, 1) != "{") bad()
      position++
      optional = ""
      count = 0
      while (1) {
        string_value()
        if (escaped) bad()
        key = parsed
        if (seen[key]++) bad()
        if (substr(line, position, 1) != ":") bad()
        position++
        count++
        if (count <= 5) {
          split("transactionProtocol operation outcome appliedCount noopCount", required, " ")
          if (key != required[count]) bad()
        } else {
          if (key !~ /^(journal|errorCode|message|disposition|authentication)$/) bad()
          optional = optional (optional == "" ? "" : ",") key
        }
        if (key == "transactionProtocol" || key == "appliedCount" || key == "noopCount") {
          number_value()
        } else {
          string_value()
        }
        value = parsed
        if (key == "transactionProtocol" && value != "1") bad()
        if (key == "operation") operation = value
        if (key == "outcome") outcome = value
        if (key == "appliedCount") applied = value
        if (key == "noopCount") noop = value
        if (key == "journal") {
          if (value == "" || value != ENVIRON["SANA_MCP_EXPECTED_JOURNAL"]) bad()
          journal = "present"
        }
        if (key == "errorCode") { if (value == "") bad(); error = "present" }
        if (key == "message") { if (value == "") bad(); message = "present" }
        if (key == "errorCode" &&
            value == "CONFIG_TRANSACTION_INTERACTION_UNAVAILABLE")
          interaction_code = "canonical"
        if (key == "message" &&
            value == "an interactive terminal is required for client selection")
          interaction_message = "canonical"
        if (key == "disposition") disposition = value
        if (key == "authentication") authentication = value
        c = substr(line, position, 1)
        if (c == "}") { position++; break }
        if (c != ",") bad()
        position++
      }
      if (position != length(line) + 1 || count < 5) bad()
      if (optional != "" &&
          optional != "disposition,authentication" &&
          optional != "disposition,authentication,errorCode,message" &&
          optional != "errorCode,message" &&
          optional != "journal" &&
          optional != "journal,errorCode,message" &&
          optional != "journal,disposition,authentication" &&
          optional != "journal,errorCode,message,disposition,authentication" &&
          optional != "journal,disposition,authentication,errorCode,message") bad()
      printf "%s %s %s %s %s %s %s %s %s\n",
        operation, outcome, applied, noop,
        disposition == "" ? "-" : disposition,
        authentication == "" ? "-" : authentication,
        journal == "" ? "absent" : journal,
        error == "present" && message == "present" ? "error" :
          error == "" && message == "" ? "none" : "partial",
        interaction_code == "canonical" &&
          interaction_message == "canonical" ? "canonical" : "other"
    }
  ' "$result_file" > "$parsed_file" || return 1
  IFS=' ' read -r config_operation config_outcome applied_count noop_count \
    config_disposition config_authentication config_journal_field config_error_fields \
    config_interaction_details \
    < "$parsed_file" || return 1
  [ "$config_operation" = "$expected_operation" ] || return 1
  [ "$config_error_fields" != "partial" ] || return 1
  case "$config_outcome" in
    applied|no-mutation|interaction-unavailable|configuration-unavailable|authentication-incomplete|failed-rolled-back|rollback-incomplete|conflict|journal-ambiguous|journal-persistence-unknown|journal-unavailable) ;;
    *) return 1 ;;
  esac
  case "$config_disposition" in
    -|configured|no-clients|no-changes|cancelled|interaction-unavailable|configuration-unavailable|authentication-incomplete) ;;
    *) return 1 ;;
  esac
  case "$config_authentication" in
    -|not-attempted|ready|skipped|retained|unconfirmed) ;;
    *) return 1 ;;
  esac
  if [ "$config_outcome" = "applied" ]; then
    case "$applied_count" in 0) return 1 ;; esac
    [ "$config_journal_field" = "present" ] || return 1
  else
    [ "$applied_count" = "0" ] || return 1
  fi
  if [ "$expected_operation" = "apply" ]; then
    [ "$config_disposition" != "-" ] && [ "$config_authentication" != "-" ] || return 1
    case "$result_status:$config_outcome" in
      0:applied)
        [ "$config_disposition" = "configured" ] &&
          [ "$config_journal_preexisting" = "0" ] &&
          [ "$config_authentication" != "unconfirmed" ] &&
          [ "$config_authentication" != "retained" ] &&
          [ "$config_error_fields" = "none" ] || return 1
        ;;
      0:no-mutation)
        [ "$config_journal_field" = "absent" ] &&
          { [ "$config_disposition" = "no-clients" ] ||
            [ "$config_disposition" = "no-changes" ] ||
            [ "$config_disposition" = "cancelled" ]; } &&
          [ "$config_authentication" != "unconfirmed" ] &&
          [ "$config_authentication" != "retained" ] &&
          [ "$config_error_fields" = "none" ] || return 1
        ;;
      1:interaction-unavailable|1:configuration-unavailable|1:authentication-incomplete|1:failed-rolled-back|1:journal-unavailable)
        [ "$config_error_fields" = "error" ] || return 1
        [ "$config_authentication" != "ready" ] || return 1
        case "$config_outcome:$config_disposition" in
          interaction-unavailable:interaction-unavailable|configuration-unavailable:configuration-unavailable|authentication-incomplete:authentication-incomplete|journal-unavailable:configuration-unavailable|failed-rolled-back:interaction-unavailable|failed-rolled-back:configuration-unavailable|failed-rolled-back:authentication-incomplete) ;;
          *) return 1 ;;
        esac
        ;;
      2:rollback-incomplete|2:conflict|2:journal-ambiguous|2:journal-persistence-unknown)
        [ "$config_error_fields" = "error" ] || return 1
        [ "$config_authentication" != "ready" ] || return 1
        case "$config_outcome:$config_disposition" in
          conflict:configuration-unavailable|journal-ambiguous:configuration-unavailable|rollback-incomplete:interaction-unavailable|rollback-incomplete:configuration-unavailable|rollback-incomplete:authentication-incomplete|journal-persistence-unknown:interaction-unavailable|journal-persistence-unknown:configuration-unavailable|journal-persistence-unknown:authentication-incomplete) ;;
          *) return 1 ;;
        esac
        ;;
      *) return 1 ;;
    esac
  else
    [ "$config_disposition" = "-" ] && [ "$config_authentication" = "-" ] || return 1
    case "$result_status:$config_outcome" in
      0:failed-rolled-back)
        [ "$config_journal_field" = "present" ] &&
          [ "$config_error_fields" = "none" ] || return 1
        ;;
      1:journal-unavailable|2:rollback-incomplete|2:conflict|2:journal-persistence-unknown)
        [ "$config_error_fields" = "error" ] || return 1
        ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

config_journal_is_regular() {
  [ -n "$config_journal_file" ] &&
    [ -f "$config_journal_file" ] &&
    [ ! -L "$config_journal_file" ]
}

remove_completed_config_journal() {
  if config_journal_is_regular; then
    rm -f "$config_journal_file" || return 1
  elif [ -e "$config_journal_file" ] || [ -L "$config_journal_file" ]; then
    return 1
  fi
  [ ! -d "$config_journal_dir" ] || rmdir "$config_journal_dir"
}

report_authentication_state() {
  case "$config_authentication" in
    ready) printf '%s\n' "Sana authentication was confirmed ready." ;;
    retained) printf '%s\n' "Existing Sana authentication was retained." ;;
    unconfirmed) printf '%s\n' "Sana authentication may have been retained but could not be confirmed." ;;
    skipped) printf '%s\n' "Sana authentication was not changed." ;;
    not-attempted|"") ;;
  esac
}

reconcile_retained_runtime() {
  [ -n "$dest" ] && [ -x "$dest" ] || return 0
  if [ "$old_present" = "1" ]; then
    if [ "$old_was_running" = "1" ]; then
      "$dest" __lifecycle start --format properties > "$tmp_dir/lifecycle.properties" 2>/dev/null &&
        lifecycle_response_is "$tmp_dir/lifecycle.properties" running
    else
      "$dest" __lifecycle stop --format properties > "$tmp_dir/lifecycle.properties" 2>/dev/null &&
        lifecycle_response_is "$tmp_dir/lifecycle.properties" stopped
    fi
  fi
}

mark_cleanup_lock_ownership_lost() {
  [ "${cleanup_lock_ownership_lost:-0}" = "0" ] || return 0
  cleanup_lock_ownership_lost=1
  can_restore=0
  retain_new_runtime=1
  preserve_tmp=1
  rollback_errors=1
  if [ "${cleanup_lock_loss_reported:-0}" = "0" ]; then
    cleanup_lock_loss_reported=1
    printf 'sana-mcp: installer lock ownership was lost; no further persistent rollback changes were attempted\n' >&2
  fi
}

refresh_cleanup_lock_ownership() {
  [ "${cleanup_lock_ownership_lost:-0}" = "0" ] || return 1
  if install_lock_is_owned && path_lock_is_owned; then
    return 0
  fi
  mark_cleanup_lock_ownership_lost
  return 1
}

record_cleanup_failure() {
  cleanup_failed=1
  preserve_tmp=1
  if [ -z "$cleanup_error_summary" ]; then
    cleanup_error_summary=$1
  else
    cleanup_error_summary="$cleanup_error_summary; $1"
  fi
}

cleanup() {
  cleanup_status=$?
  cleanup_failed=0
  cleanup_error_summary=""
  set +e
  if [ "$transaction_active" = "1" ] && [ "$committed" = "0" ]; then
    rollback_errors=0
    can_restore=1
    cleanup_lock_ownership_lost=0
    cleanup_lock_loss_reported=0
    refresh_cleanup_lock_ownership || :
    if [ "$live_state_touched" = "1" ]; then
      can_restore=0
      retain_new_runtime=1
      preserve_tmp=1
      if refresh_cleanup_lock_ownership &&
        [ "$config_transaction_state" = "applied" ]; then
        set +e
        "$dest" __configure-transaction rollback --journal "$config_journal_dir" \
          > "$tmp_dir/config-rollback.json"
        config_rollback_status=$?
        set +e
        refresh_cleanup_lock_ownership || :
        if [ "$cleanup_lock_ownership_lost" = "0" ] &&
          [ "$config_rollback_status" -eq 0 ] &&
          read_config_transaction_result "$tmp_dir/config-rollback.json" rollback "$config_rollback_status" &&
          [ "$config_outcome" = "failed-rolled-back" ]; then
          config_transaction_state=safe-rolled-back
          if refresh_cleanup_lock_ownership; then
            remove_completed_config_journal ||
              printf 'sana-mcp: client configuration was rolled back, but its completed journal could not be removed: %s\n' "$config_journal_dir" >&2
          fi
        else
          rollback_errors=1
          if [ "$cleanup_lock_ownership_lost" = "0" ]; then
            printf 'sana-mcp: client configuration rollback was incomplete; the replacement runtime and recovery journal were retained\n' >&2
          fi
        fi
      fi
      if refresh_cleanup_lock_ownership; then
        reconcile_retained_runtime || rollback_errors=1
        refresh_cleanup_lock_ownership || :
      fi
    elif [ "$retain_new_runtime" = "1" ]; then
      can_restore=0
      preserve_tmp=1
    fi
    if [ "$can_restore" = "1" ]; then
      refresh_cleanup_lock_ownership || :
    fi
    if [ "$can_restore" = "1" ]; then
      if [ "$old_present" = "1" ]; then
        rollback_binary=$(mktemp "$install_dir/.sana-mcp-rollback.XXXXXX") || rollback_binary=""
        staged_binary=$rollback_binary
        rollback_receipt=""
        if [ -n "$rollback_binary" ] && refresh_cleanup_lock_ownership; then
          rollback_receipt=$(mktemp "$install_dir/.sana-mcp-receipt-rollback.XXXXXX") ||
            rollback_receipt=""
        fi
        staged_receipt=$rollback_receipt
        if [ -n "$rollback_binary" ] && [ -n "$rollback_receipt" ] &&
          refresh_cleanup_lock_ownership &&
          cp "$tmp_dir/old-binary" "$rollback_binary" &&
          refresh_cleanup_lock_ownership &&
          chmod 755 "$rollback_binary" &&
          refresh_cleanup_lock_ownership &&
          mv -f "$rollback_binary" "$dest" &&
          refresh_cleanup_lock_ownership &&
          cp "$tmp_dir/old-receipt" "$rollback_receipt" &&
          refresh_cleanup_lock_ownership &&
          chmod 600 "$rollback_receipt" &&
          refresh_cleanup_lock_ownership &&
          mv -f "$rollback_receipt" "$receipt"; then
          files_restored=1
        else
          rollback_errors=1
          files_restored=0
        fi
      else
        files_restored=1
        [ -z "$dest" ] || {
          refresh_cleanup_lock_ownership && rm -f "$dest"
        } || {
          rollback_errors=1
          files_restored=0
        }
        [ -z "$receipt" ] || {
          refresh_cleanup_lock_ownership && rm -f "$receipt"
        } || {
          rollback_errors=1
          files_restored=0
        }
      fi
    else
      files_restored=0
    fi
    if [ "$can_restore" = "1" ]; then
      refresh_cleanup_lock_ownership || :
    fi
    if [ "$can_restore" = "1" ] && [ "$path_changed" = "1" ] && [ -n "$path_file" ]; then
      current_path_sha256=absent
      if [ -f "$path_file" ]; then
        current_path_sha256=$(hash_file "$path_file") || current_path_sha256=unavailable
      fi
      refresh_cleanup_lock_ownership || :
      if [ "$can_restore" = "1" ]; then
        if [ "$current_path_sha256" = "$path_written_sha256" ]; then
          if [ "$path_existed" = "1" ]; then
            rollback_path=$(mktemp "$path_file.sana-mcp-rollback.XXXXXX") || rollback_path=""
            staged_path=$rollback_path
            if [ -n "$rollback_path" ] &&
              refresh_cleanup_lock_ownership &&
              cp -p "$tmp_dir/old-path-file" "$rollback_path" &&
              refresh_cleanup_lock_ownership &&
              sync &&
              [ "$(hash_file "$path_file")" = "$path_written_sha256" ] &&
              refresh_cleanup_lock_ownership &&
              mv -f "$rollback_path" "$path_file"; then
              staged_path=""
              refresh_cleanup_lock_ownership || :
              if [ "$cleanup_lock_ownership_lost" = "0" ]; then
                sync || rollback_errors=1
              fi
            else
              rollback_errors=1
            fi
          else
            refresh_cleanup_lock_ownership &&
              rm -f "$path_file" || rollback_errors=1
            refresh_cleanup_lock_ownership || :
            if [ "$cleanup_lock_ownership_lost" = "0" ]; then
              sync || rollback_errors=1
            fi
          fi
        elif [ "$current_path_sha256" = "$path_preimage_sha256" ]; then
          :
        else
          rollback_errors=1
        fi
      fi
    fi
    refresh_cleanup_lock_ownership || :
    if [ "$cleanup_lock_ownership_lost" = "0" ] &&
      [ "$old_present" = "1" ] && [ "$old_was_running" = "1" ] &&
      [ "$files_restored" = "1" ]; then
      if ! "$dest" __lifecycle start --format properties > "$tmp_dir/lifecycle.properties" 2>/dev/null ||
        ! lifecycle_response_is "$tmp_dir/lifecycle.properties" running; then
        rollback_errors=1
      fi
      refresh_cleanup_lock_ownership || :
    fi
    if [ "$retain_new_runtime" = "1" ]; then
      preserve_tmp=1
      printf 'sana-mcp: retained the replacement runtime at %s\n' "$dest" >&2
      if [ -n "$config_journal_dir" ] &&
        { [ -e "$config_journal_file" ] || [ -L "$config_journal_file" ]; }; then
        printf 'sana-mcp: client configuration recovery journal: %s\n' "$config_journal_dir" >&2
      fi
      printf 'sana-mcp: previous runtime backup and recovery inventory: %s\n' "$tmp_dir" >&2
    fi
    if [ "$rollback_errors" != "0" ]; then
      preserve_tmp=1
      printf 'sana-mcp: installation rollback was incomplete; preserve %s and retry manually\n' "$tmp_dir" >&2
    fi
  fi
  if [ "$transaction_active" = "1" ] && [ "$committed" = "0" ]; then
    refresh_cleanup_lock_ownership || :
  fi
  if [ "${cleanup_lock_ownership_lost:-0}" = "0" ]; then
    if [ "$path_lock_acquired" = "0" ] && [ "$path_lock_created" = "1" ] &&
      ! cleanup_unowned_path_lock_artifacts; then
      record_cleanup_failure "the unverified user-state lock artifacts could not be removed"
    fi
    if [ "$install_lock_acquired" = "0" ] && [ "$install_lock_created" = "1" ] &&
      ! cleanup_unowned_install_lock_artifacts; then
      record_cleanup_failure "the unverified install-lock artifacts could not be removed"
    fi
    if ! release_path_lock; then
      record_cleanup_failure "the per-user installer lock could not be released"
    fi
    if [ "${cleanup_lock_ownership_lost:-0}" = "0" ] &&
      ! release_install_lock; then
      record_cleanup_failure "the sana-mcp install lock could not be released"
    fi
    if [ "${cleanup_lock_ownership_lost:-0}" = "0" ]; then
      if [ -n "$staged_binary" ] && ! rm -f "$staged_binary"; then
        record_cleanup_failure "the staged binary could not be removed"
      fi
      if [ -n "$staged_receipt" ] && ! rm -f "$staged_receipt"; then
        record_cleanup_failure "the staged receipt could not be removed"
      fi
      if [ -n "$staged_path" ] && ! rm -f "$staged_path"; then
        record_cleanup_failure "the staged PATH file could not be removed"
      fi
    fi
    if [ -n "$tmp_dir" ] && [ "$preserve_tmp" = "0" ]; then
      if ! rm -f \
        "$tmp_dir/bootstrap.properties" \
        "$tmp_dir/bootstrap.properties.sha256" \
        "$tmp_dir/release.properties" \
        "$tmp_dir/release.properties.sha256" \
        "$tmp_dir/manifest.json" \
        "$tmp_dir/manifest.json.sha256" \
        "$tmp_dir/binary" \
        "$tmp_dir/binary.sha256" \
        "$tmp_dir/inspect.properties"; then
        record_cleanup_failure "the downloaded temporary files could not be removed"
      fi
      if ! rm -f \
        "$tmp_dir/old-binary" \
        "$tmp_dir/old-receipt" \
        "$tmp_dir/old-inspect.properties" \
        "$tmp_dir/lifecycle.properties" \
        "$tmp_dir/old-path-file" \
        "$tmp_dir/path-block" \
        "$tmp_dir/existing-path-block" \
        "$tmp_dir/path-without-block" \
        "$tmp_dir/new-receipt" \
        "$tmp_dir/config-apply.json" \
        "$tmp_dir/config-result.parsed" \
        "$tmp_dir/config-rollback.json"; then
        record_cleanup_failure "the rollback temporary files could not be removed"
      fi
      if ! rmdir "$tmp_dir"; then
        record_cleanup_failure "the temporary installer directory could not be removed"
      fi
    fi
  fi
  if [ "$cleanup_failed" = "1" ]; then
    printf 'sana-mcp: cleanup was incomplete: %s\n' "$cleanup_error_summary" >&2
  fi
  cleanup_final_status=$cleanup_status
  if [ "$cleanup_final_status" -eq 0 ] && [ "$cleanup_failed" = "1" ]; then
    cleanup_final_status=1
  fi
  trap - 0
  exit "$cleanup_final_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v curl >/dev/null 2>&1 || fail "curl is required"
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "SHA-256 verification requires sha256sum or shasum"
fi

download() {
  curl -fL \
    --proto '=https' \
    --proto-redir '=https' \
    --max-redirs 5 \
    --connect-timeout 15 \
    --max-time 300 \
    --retry 2 \
    --retry-delay 1 \
    --silent \
    --show-error \
    "$1" \
    -o "$2"
}

download_binary() {
  curl -fL \
    --proto '=https' \
    --proto-redir '=https' \
    --max-redirs 5 \
    --connect-timeout 15 \
    --max-time 600 \
    --retry 2 \
    --retry-delay 1 \
    --progress-bar \
    "$1" \
    -o "$2"
}

validate_release_tag() {
  awk -v tag="$1" 'BEGIN {
    core = "(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"
    identifier = "(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
    prerelease = "(-" identifier "(\\." identifier ")*)?"
    build = "(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?"
    exit !(tag ~ ("^v" core prerelease build "$"))
  }' || fail "release metadata contains an invalid tag"
}

read_properties() {
  properties_file=$1
  P_format=""; P_manifestVersion=""; P_manifestSha256=""
  P_packageVersion=""; P_releaseTag=""; P_sourceCommit=""; P_installerProtocol=""
  P_lifecycleProtocol=""; P_inspectProtocol=""; P_stateCompatibility=""
  P_semanticCapability=""; P_installerAssetName=""; P_installerSha256=""
  P_target=""; P_libc=""; P_assetName=""; P_checksumFileName=""; P_sha256=""
  seen=" "
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      *=*) key=${line%%=*}; value=${line#*=} ;;
      *) fail "release metadata is malformed" ;;
    esac
    case "$key" in
      *[!A-Za-z0-9]*) fail "release metadata contains an invalid key" ;;
    esac
    case "$seen" in
      *" $key "*) fail "release metadata repeats $key" ;;
    esac
    seen="${seen}${key} "
    case "$value" in
      ""|*[!A-Za-z0-9._+-]*) fail "release metadata contains an invalid $key" ;;
    esac
    case "$key" in
      format) P_format=$value ;;
      manifestVersion) P_manifestVersion=$value ;;
      manifestSha256) P_manifestSha256=$value ;;
      packageVersion) P_packageVersion=$value ;;
      releaseTag) P_releaseTag=$value ;;
      sourceCommit) P_sourceCommit=$value ;;
      installerProtocol) P_installerProtocol=$value ;;
      lifecycleProtocol) P_lifecycleProtocol=$value ;;
      inspectProtocol) P_inspectProtocol=$value ;;
      stateCompatibility) P_stateCompatibility=$value ;;
      semanticCapability) P_semanticCapability=$value ;;
      installerAssetName) P_installerAssetName=$value ;;
      installerSha256) P_installerSha256=$value ;;
      target) P_target=$value ;;
      libc) P_libc=$value ;;
      assetName) P_assetName=$value ;;
      checksumFileName) P_checksumFileName=$value ;;
      sha256) P_sha256=$value ;;
      *) fail "release metadata contains unknown key $key" ;;
    esac
  done < "$properties_file"

  [ "$P_format" = "sana-mcp-release-v1" ] || fail "unsupported release metadata format"
  [ "$P_manifestVersion" = "1" ] || fail "unsupported release manifest version"
  [ "$P_installerProtocol" = "1" ] || fail "unsupported installer protocol"
  [ "$P_lifecycleProtocol" = "1" ] || fail "unsupported lifecycle protocol"
  [ "$P_inspectProtocol" = "1" ] || fail "unsupported inspect protocol"
  case "$P_stateCompatibility" in
    ""|0|0*|*[!0-9]*) fail "release state compatibility is invalid" ;;
  esac
  [ "$P_semanticCapability" = "keyword" ] || fail "unsupported binary capability"
  [ "$P_installerAssetName" = "install.sh" ] ||
    fail "release metadata does not bind the POSIX installer"
  [ "${#P_installerSha256}" -eq 64 ] ||
    fail "release installer SHA-256 is invalid"
  case "$P_installerSha256" in
    *[!a-f0-9]*) fail "release installer SHA-256 is invalid" ;;
  esac
  [ "$P_target" = "$target" ] || fail "release metadata target does not match this system"
  [ "$P_releaseTag" = "v$P_packageVersion" ] || fail "release version and tag do not match"
  validate_release_tag "$P_releaseTag"
  [ "${#P_sourceCommit}" -eq 40 ] || fail "release source commit is invalid"
  case "$P_sourceCommit" in
    *[!a-f0-9]*) fail "release source commit is invalid" ;;
  esac
  [ "$P_assetName" = "$expected_asset_name" ] ||
    fail "release metadata asset name does not match its target"
  [ "$P_checksumFileName" = "$P_assetName.sha256" ] ||
    fail "release metadata checksum filename does not match its binary"
  [ "${#P_manifestSha256}" -eq 64 ] || fail "release manifest SHA-256 is invalid"
  [ "${#P_sha256}" -eq 64 ] || fail "release binary SHA-256 is invalid"
  case "$P_manifestSha256$P_sha256" in
    *[!a-f0-9]*) fail "release metadata contains an invalid SHA-256" ;;
  esac
  case "$P_assetName$P_checksumFileName" in
    *[!A-Za-z0-9._-]*) fail "release metadata contains an unsafe filename" ;;
  esac
  case "$target" in
    bun-linux-*-musl) [ "$P_libc" = "musl" ] || fail "release libc does not match this system" ;;
    bun-linux-*) [ "$P_libc" = "glibc" ] || fail "release libc does not match this system" ;;
    *) [ -z "$P_libc" ] || fail "non-Linux release metadata must not declare libc" ;;
  esac
}

read_checksum() {
  checksum_file=$1
  expected_name=$2
  checksum_body=$(cat "$checksum_file") ||
    fail "checksum file for $expected_name could not be read"
  checksum_hash=${checksum_body%% *}
  [ "${#checksum_hash}" -eq 64 ] || fail "checksum for $expected_name is invalid"
  case "$checksum_hash" in
    *[!a-f0-9]*) fail "checksum for $expected_name is invalid" ;;
  esac
  [ "$checksum_body" = "$checksum_hash  $expected_name" ] ||
    fail "checksum file for $expected_name is malformed or names the wrong asset"
}

read_inspect() {
  inspect_file=$1
  expected_version=$2
  expected_target=$3
  inspect_context=$4
  I_inspectProtocol=""; I_version=""; I_target=""
  I_installerProtocol=""; I_lifecycleProtocol=""; I_stateCompatibility=""
  I_semanticCapability=""
  seen=" "
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      *=*) key=${line%%=*}; value=${line#*=} ;;
      *) fail "downloaded binary returned malformed inspection data" ;;
    esac
    case "$seen" in
      *" $key "*) fail "downloaded binary repeats inspection key $key" ;;
    esac
    seen="${seen}${key} "
    case "$value" in
      ""|*[!A-Za-z0-9._+-]*) fail "downloaded binary returned invalid inspection data" ;;
    esac
    case "$key" in
      inspectProtocol) I_inspectProtocol=$value ;;
      version) I_version=$value ;;
      target) I_target=$value ;;
      installerProtocol) I_installerProtocol=$value ;;
      lifecycleProtocol) I_lifecycleProtocol=$value ;;
      stateCompatibility) I_stateCompatibility=$value ;;
      semanticCapability) I_semanticCapability=$value ;;
      *) fail "downloaded binary returned an unknown inspection field" ;;
    esac
  done < "$inspect_file"

  case "$inspect_context" in
    release)
      expected_installer_protocol=$P_installerProtocol
      expected_lifecycle_protocol=$P_lifecycleProtocol
      expected_inspect_protocol=$P_inspectProtocol
      expected_state_compatibility=$P_stateCompatibility
      [ -n "$I_stateCompatibility" ] ||
        fail "downloaded binary did not report state compatibility"
      ;;
    receipt)
      expected_installer_protocol=$R_installerProtocol
      expected_lifecycle_protocol=$R_lifecycleProtocol
      expected_inspect_protocol=$R_inspectProtocol
      expected_state_compatibility=$R_stateCompatibility
      if [ "$R_format" = "sana-mcp-install-v1" ] &&
        [ -z "$I_stateCompatibility" ]; then
        I_stateCompatibility=1
      fi
      [ -n "$I_stateCompatibility" ] ||
        fail "existing binary did not report the state compatibility in its installer receipt"
      ;;
    *) fail "installer inspection context is invalid" ;;
  esac

  [ "$I_inspectProtocol" = "$expected_inspect_protocol" ] &&
    [ "$I_version" = "$expected_version" ] &&
    [ "$I_target" = "$expected_target" ] &&
    [ "$I_installerProtocol" = "$expected_installer_protocol" ] &&
    [ "$I_lifecycleProtocol" = "$expected_lifecycle_protocol" ] &&
    [ "$I_stateCompatibility" = "$expected_state_compatibility" ] &&
    [ "$I_semanticCapability" = "keyword" ] ||
    fail "binary identity does not match its authoritative release metadata"
}

read_receipt() {
  receipt_file=$1
  R_format=""; R_version=""; R_target=""; R_sourceCommit=""
  R_binarySha256=""; R_pathProfile=""; R_pathBlockSha256=""
  R_installerProtocol=""; R_lifecycleProtocol=""; R_inspectProtocol=""
  R_stateCompatibility=""
  seen=" "
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      *=*) key=${line%%=*}; value=${line#*=} ;;
      *) fail "installer receipt is malformed; refusing to replace the existing binary" ;;
    esac
    case "$seen" in
      *" $key "*) fail "installer receipt repeats $key" ;;
    esac
    seen="${seen}${key} "
    case "$value" in
      ""|*[!A-Za-z0-9._+-]*) fail "installer receipt contains an invalid value" ;;
    esac
    case "$key" in
      format) R_format=$value ;;
      version) R_version=$value ;;
      target) R_target=$value ;;
      sourceCommit) R_sourceCommit=$value ;;
      binarySha256) R_binarySha256=$value ;;
      pathProfile) R_pathProfile=$value ;;
      pathBlockSha256) R_pathBlockSha256=$value ;;
      installerProtocol) R_installerProtocol=$value ;;
      lifecycleProtocol) R_lifecycleProtocol=$value ;;
      inspectProtocol) R_inspectProtocol=$value ;;
      stateCompatibility) R_stateCompatibility=$value ;;
      *) fail "installer receipt contains an unknown key" ;;
    esac
  done < "$receipt_file"
  case "$R_format" in
    sana-mcp-install-v1)
      [ -z "$R_installerProtocol$R_lifecycleProtocol$R_inspectProtocol$R_stateCompatibility" ] ||
        fail "version 1 installer receipt contains version 2 state"
      R_installerProtocol=1
      R_lifecycleProtocol=1
      R_inspectProtocol=1
      R_stateCompatibility=1
      ;;
    sana-mcp-install-v2)
      [ "$R_installerProtocol" = "1" ] &&
        [ "$R_lifecycleProtocol" = "1" ] &&
        [ "$R_inspectProtocol" = "1" ] ||
        fail "version 2 installer receipt protocol state is invalid"
      case "$R_stateCompatibility" in
        ""|0|0*|*[!0-9]*) fail "version 2 installer receipt state compatibility is invalid" ;;
      esac
      ;;
    *) fail "existing binary has no supported installer receipt" ;;
  esac
  validate_release_tag "v$R_version"
  [ "${#R_sourceCommit}" -eq 40 ] || fail "installer receipt source commit is invalid"
  [ "${#R_binarySha256}" -eq 64 ] || fail "installer receipt binary hash is invalid"
  case "$R_sourceCommit$R_binarySha256" in
    *[!a-f0-9]*) fail "installer receipt integrity fields are invalid" ;;
  esac
  case "$R_pathProfile" in
    bashrc|zshrc|profile|none) ;;
    *) fail "installer receipt PATH profile is invalid" ;;
  esac
  if [ "$R_pathProfile" = "none" ]; then
    [ "$R_pathBlockSha256" = "none" ] ||
      fail "installer receipt PATH state is inconsistent"
  else
    [ "${#R_pathBlockSha256}" -eq 64 ] ||
      fail "installer receipt PATH block hash is invalid"
    case "$R_pathBlockSha256" in
      *[!a-f0-9]*) fail "installer receipt PATH block hash is invalid" ;;
    esac
  fi
}

read_lifecycle() {
  lifecycle_file=$1
  L_protocol=""; L_state=""; L_changed=""; seen=" "
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    case "$line" in
      *=*) key=${line%%=*}; value=${line#*=} ;;
      *) fail "installed runtime returned malformed lifecycle data" ;;
    esac
    case "$seen" in
      *" $key "*) fail "installed runtime repeated lifecycle field $key" ;;
    esac
    seen="${seen}${key} "
    case "$key" in
      lifecycleProtocol) L_protocol=$value ;;
      state) L_state=$value ;;
      changed) L_changed=$value ;;
      *) fail "installed runtime returned an unknown lifecycle field" ;;
    esac
  done < "$lifecycle_file"
  [ "$L_protocol" = "1" ] || fail "installed runtime uses an unsupported lifecycle protocol"
  case "$L_state" in running|stopped) ;; *) fail "installed runtime returned an invalid daemon state" ;; esac
  case "$L_changed" in true|false) ;; *) fail "installed runtime returned an invalid lifecycle result" ;; esac
}

lifecycle_response_is() {
  lifecycle_check_file=$1
  lifecycle_expected_state=$2
  awk -F= -v expected="$lifecycle_expected_state" '
    BEGIN { protocol=0; state=0; changed=0; invalid=0 }
    $0 == "lifecycleProtocol=1" { protocol++; next }
    $0 == "state=" expected { state++; next }
    $0 == "changed=true" || $0 == "changed=false" { changed++; next }
    { invalid=1 }
    END {
      exit !(protocol == 1 && state == 1 && changed == 1 && invalid == 0)
    }
  ' "$lifecycle_check_file"
}

profile_file() {
  case "$1" in
    bashrc) printf '%s\n' "$HOME/.bashrc" ;;
    zshrc) printf '%s\n' "$HOME/.zshrc" ;;
    profile) printf '%s\n' "$HOME/.profile" ;;
    none) printf '\n' ;;
    *) fail "invalid PATH profile" ;;
  esac
}

select_path_profile() {
  case "${SHELL:-}" in
    */bash|bash) candidate="bashrc" ;;
    */zsh|zsh) candidate="zshrc" ;;
    *) candidate="none" ;;
  esac
  printf '%s\n' "$candidate"
}

write_path_block() {
  block_file=$1
  {
    printf '%s\n' '# >>> sana-mcp installer >>>'
    printf "export PATH='%s':\"\$PATH\"\n" "$install_dir"
    printf '%s\n' '# <<< sana-mcp installer <<<'
  } > "$block_file"
}

verify_or_apply_path_block() {
  selected_profile=$1
  [ "$selected_profile" != "none" ] || return 0
  assert_installer_locks_owned
  path_file=$(profile_file "$selected_profile")
  [ ! -L "$path_file" ] ||
    fail "shell startup file must not be a symbolic link: $path_file"
  [ ! -e "$path_file" ] || [ -f "$path_file" ] ||
    fail "shell startup path is not a regular file: $path_file"
  write_path_block "$tmp_dir/path-block"
  begin_count=$(grep -cF '# >>> sana-mcp installer >>>' "$path_file" 2>/dev/null) || begin_count=0
  end_count=$(grep -cF '# <<< sana-mcp installer <<<' "$path_file" 2>/dev/null) || end_count=0
  if [ "$begin_count" -gt 1 ] || [ "$end_count" -gt 1 ] ||
    [ "$begin_count" -ne "$end_count" ]; then
    fail "the managed sana-mcp PATH block in $path_file is malformed"
  fi
  if [ "$old_present" = "1" ]; then
    [ "$begin_count" -eq 1 ] ||
      fail "the installer-owned PATH block recorded by the receipt is missing"
    awk '
      $0 == "# >>> sana-mcp installer >>>" { capture=1 }
      capture { print }
      $0 == "# <<< sana-mcp installer <<<" { capture=0 }
    ' "$path_file" > "$tmp_dir/existing-path-block"
    [ "$(hash_file "$tmp_dir/existing-path-block")" = "$R_pathBlockSha256" ] ||
      fail "the installer-owned PATH block was changed; refusing to overwrite it"
    return 0
  elif [ "$begin_count" -ne 0 ]; then
    fail "a sana-mcp PATH block exists without an installer receipt"
  fi

  if [ -f "$path_file" ]; then
    cp -p "$path_file" "$tmp_dir/old-path-file"
    path_existed=1
    path_preimage_sha256=$(hash_file "$path_file")
  else
    path_existed=0
    path_preimage_sha256=absent
  fi

  staged_path=$(mktemp "$path_file.sana-mcp.XXXXXX") ||
    fail "could not stage the PATH update beside $path_file"
  if [ "$path_existed" = "1" ]; then
    cp -p "$path_file" "$staged_path"
    if [ -s "$staged_path" ] && [ -n "$(tail -c 1 "$staged_path")" ]; then
      printf '\n' >> "$staged_path"
    fi
    printf '\n' >> "$staged_path"
  fi
  cat "$tmp_dir/path-block" >> "$staged_path"
  path_written_sha256=$(hash_file "$staged_path")
  path_changed=1
  sync

  current_path_sha256=absent
  if [ -f "$path_file" ]; then
    current_path_sha256=$(hash_file "$path_file")
  fi
  [ "$current_path_sha256" = "$path_preimage_sha256" ] ||
    fail "shell startup file changed while the PATH update was being prepared"
  assert_installer_locks_owned
  mv -f "$staged_path" "$path_file"
  staged_path=""
  [ "$(hash_file "$path_file")" = "$path_written_sha256" ] ||
    fail "published shell PATH update could not be verified"
  sync
}

revalidate_path_block_for_commit() {
  selected_profile=$1
  [ "$selected_profile" != "none" ] || return 0
  assert_installer_locks_owned
  commit_path_file=$(profile_file "$selected_profile")
  [ ! -L "$commit_path_file" ] && [ -f "$commit_path_file" ] ||
    fail "shell startup file became unavailable before receipt commit"
  begin_count=$(grep -cF '# >>> sana-mcp installer >>>' "$commit_path_file" 2>/dev/null) || begin_count=0
  end_count=$(grep -cF '# <<< sana-mcp installer <<<' "$commit_path_file" 2>/dev/null) || end_count=0
  [ "$begin_count" -eq 1 ] && [ "$end_count" -eq 1 ] ||
    fail "managed sana-mcp PATH block changed before receipt commit"
  awk '
    $0 == "# >>> sana-mcp installer >>>" { capture=1 }
    capture { print }
    $0 == "# <<< sana-mcp installer <<<" { capture=0 }
  ' "$commit_path_file" > "$tmp_dir/existing-path-block"
  [ "$(hash_file "$tmp_dir/existing-path-block")" = "$expected_path_hash" ] ||
    fail "managed sana-mcp PATH block changed before receipt commit"
}

os=$(uname -s) || fail "could not determine the operating system"
arch=$(uname -m) || fail "could not determine the architecture"
case "$arch" in
  x86_64|amd64) machine="x64" ;;
  aarch64|arm64) machine="arm64" ;;
  *) fail "unsupported architecture: $arch" ;;
esac
case "$os" in
  Darwin)
    target="bun-darwin-$machine"
    expected_asset_name="sana-mcp-darwin-$machine"
    ;;
  Linux)
    if [ -x "/lib/ld-musl-${arch}.so.1" ]; then
      libc="musl"
    elif command -v getconf >/dev/null 2>&1 &&
      getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
      libc="glibc"
    elif command -v ldd >/dev/null 2>&1 &&
      ldd --version 2>&1 | awk 'BEGIN { found=0 } /musl/ { found=1 } END { exit !found }'; then
      libc="musl"
    else
      fail "could not determine whether this Linux system uses glibc or musl"
    fi
    if [ "$libc" = "musl" ]; then
      target="bun-linux-$machine-musl"
      expected_asset_name="sana-mcp-linux-$machine-musl"
    else
      target="bun-linux-$machine"
      expected_asset_name="sana-mcp-linux-$machine"
    fi
    ;;
  *) fail "unsupported OS: $os (on Windows use install.ps1)" ;;
esac

if [ "${libc:-}" = "musl" ] && command -v apk >/dev/null 2>&1; then
  if ! apk info --exists libstdc++ >/dev/null 2>&1 ||
    ! apk info --exists libgcc >/dev/null 2>&1; then
    fail "Alpine requires the libstdc++ and libgcc runtime packages. Run: apk add --no-cache libstdc++ libgcc. Then rerun this installer."
  fi
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/sana-mcp.XXXXXX") ||
  fail "could not create a temporary directory"
metadata_name="manifest-${target}.properties"

if [ -n "${SANA_MCP_VERSION:-}" ]; then
  validate_release_tag "$SANA_MCP_VERSION"
  version=$SANA_MCP_VERSION
else
  latest_url="https://github.com/$repo/releases/latest/download/$metadata_name"
  download "$latest_url" "$tmp_dir/bootstrap.properties" ||
    fail "could not resolve the latest sana-mcp release"
  download "$latest_url.sha256" "$tmp_dir/bootstrap.properties.sha256" ||
    fail "could not verify the latest sana-mcp release metadata"
  read_checksum "$tmp_dir/bootstrap.properties.sha256" "$metadata_name"
  [ "$(hash_file "$tmp_dir/bootstrap.properties")" = "$checksum_hash" ] ||
    fail "latest release metadata checksum mismatch"
  read_properties "$tmp_dir/bootstrap.properties"
  version=$P_releaseTag
fi

base_url="https://github.com/$repo/releases/download/$version"
printf 'Installing sana-mcp %s (%s)\n' "$version" "$target"

download "$base_url/$metadata_name" "$tmp_dir/release.properties" ||
  fail "could not download release metadata"
download "$base_url/$metadata_name.sha256" "$tmp_dir/release.properties.sha256" ||
  fail "could not download the release metadata checksum"
read_checksum "$tmp_dir/release.properties.sha256" "$metadata_name"
[ "$(hash_file "$tmp_dir/release.properties")" = "$checksum_hash" ] ||
  fail "release metadata checksum mismatch"
read_properties "$tmp_dir/release.properties"
[ "$P_releaseTag" = "$version" ] || fail "release metadata resolved to a different tag"

download "$base_url/manifest.json" "$tmp_dir/manifest.json" ||
  fail "could not download the release manifest"
download "$base_url/manifest.json.sha256" "$tmp_dir/manifest.json.sha256" ||
  fail "could not download the release manifest checksum"
read_checksum "$tmp_dir/manifest.json.sha256" "manifest.json"
manifest_hash=$(hash_file "$tmp_dir/manifest.json")
[ "$manifest_hash" = "$checksum_hash" ] || fail "release manifest checksum mismatch"

download "$base_url/$P_checksumFileName" "$tmp_dir/binary.sha256" ||
  fail "could not download the binary checksum"
read_checksum "$tmp_dir/binary.sha256" "$P_assetName"
download_binary "$base_url/$P_assetName" "$tmp_dir/binary" ||
  fail "could not download the sana-mcp binary"
[ "$(hash_file "$tmp_dir/binary")" = "$P_sha256" ] ||
  fail "downloaded binary checksum mismatch"

chmod 755 "$tmp_dir/binary"
"$tmp_dir/binary" __inspect --format properties > "$tmp_dir/inspect.properties" ||
  fail "downloaded binary could not report its release identity"
read_inspect "$tmp_dir/inspect.properties" "$P_packageVersion" "$P_target" release

if [ -n "${SANA_MCP_INSTALL_DIR:-}" ]; then
  install_dir=$SANA_MCP_INSTALL_DIR
else
  [ -n "${HOME:-}" ] || fail "HOME is required unless SANA_MCP_INSTALL_DIR is set"
  install_dir="$HOME/.local/bin"
fi
case "$install_dir" in
  /*) ;;
  *) fail "SANA_MCP_INSTALL_DIR must be an absolute path" ;;
esac
carriage_return=$(printf '\r')
case "$install_dir" in
  *"'"*|*:*|*"$carriage_return"*|*'
'*)
    fail "SANA_MCP_INSTALL_DIR contains an apostrophe, colon, or line break that cannot be stored safely in PATH"
    ;;
esac
[ ! -L "$install_dir" ] || fail "installation directory must not be a symbolic link"
mkdir -p "$install_dir"
[ ! -L "$install_dir" ] || fail "installation directory must not be a symbolic link"

dest="$install_dir/sana-mcp"
receipt="$install_dir/.sana-mcp-install-v1"
install_lock="$install_dir/.sana-mcp-install-lock"
if ! mkdir "$install_lock" 2>/dev/null; then
  fail "another sana-mcp installation is active in $install_dir"
fi
install_lock_created=1
install_lock_token=$(mktemp "$install_lock/owner.XXXXXX") || {
  cleanup_unowned_install_lock_artifacts || :
  fail "could not establish ownership of the sana-mcp install lock"
}
install_lock_token_created=1
install_lock_value=${install_lock_token##*/}
if ! printf '%s\n' "$install_lock_value" > "$install_lock_token"; then
  cleanup_unowned_install_lock_artifacts || :
  fail "could not record ownership of the sana-mcp install lock"
fi
install_lock_acquired=1

[ ! -L "$dest" ] || fail "refusing to replace a symbolic-link destination"
[ ! -L "$receipt" ] || fail "refusing an installer receipt symbolic link"
if [ -e "$dest" ] || [ -e "$receipt" ]; then
  if [ -f "$dest" ] && [ ! -e "$receipt" ]; then
    fail "existing $dest has no supported installer receipt; if it is a pre-receipt sana-mcp install, rename it as a backup and rerun (this refusal leaves authentication and meeting data untouched)"
  fi
  [ -f "$dest" ] && [ -f "$receipt" ] ||
    fail "existing installation is incomplete or not installer-owned"
  read_receipt "$receipt"
  [ "$R_target" = "$target" ] ||
    fail "existing installer receipt targets a different platform"
  current_binary_sha256=$(hash_file "$dest")
  [ "$current_binary_sha256" = "$R_binarySha256" ] ||
    fail "existing binary changed after installation; refusing to overwrite it"
  if [ "${SANA_MCP_UPDATE:-0}" = "1" ]; then
    [ "${SANA_MCP_EXPECTED_INSTALLED_VERSION:-}" = "$R_version" ] &&
      [ "${SANA_MCP_EXPECTED_INSTALLED_TARGET:-}" = "$R_target" ] &&
      [ "${SANA_MCP_EXPECTED_INSTALLED_SHA256:-}" = "$current_binary_sha256" ] &&
      [ "${SANA_MCP_EXPECTED_INSTALLED_STATE_COMPATIBILITY:-}" = "$R_stateCompatibility" ] ||
      fail "installed runtime changed after sana-mcp update obtained authority"
  fi
  "$dest" __inspect --format properties > "$tmp_dir/old-inspect.properties" ||
    fail "existing binary cannot prove its installer identity"
  read_inspect "$tmp_dir/old-inspect.properties" "$R_version" "$R_target" receipt
  [ "$R_stateCompatibility" = "$P_stateCompatibility" ] ||
    fail "existing local state is incompatible with this release; automatic POSIX state replacement is not supported yet"
  "$dest" __lifecycle health --format properties > "$tmp_dir/lifecycle.properties" ||
    fail "existing runtime does not support the required lifecycle protocol"
  read_lifecycle "$tmp_dir/lifecycle.properties"
  [ "$L_state" != "running" ] || old_was_running=1
  cp "$dest" "$tmp_dir/old-binary"
  cp "$receipt" "$tmp_dir/old-receipt"
  old_present=1
  path_profile=$R_pathProfile
else
  [ "${SANA_MCP_UPDATE:-0}" != "1" ] ||
    fail "installed runtime changed after sana-mcp update obtained authority"
  if [ -n "${HOME:-}" ]; then
    path_profile=$(select_path_profile)
  else
    path_profile=none
  fi
fi
if [ -n "${HOME:-}" ]; then
  current_shell_path_profile=$(select_path_profile)
else
  current_shell_path_profile=none
fi
should_run_after_install=$old_was_running
if [ "$old_present" = "1" ] && [ "${SANA_MCP_UPDATE:-0}" != "1" ]; then
  should_run_after_install=1
fi

write_path_block "$tmp_dir/path-block"
if [ "$path_profile" != "none" ]; then
  expected_path_hash=$(hash_file "$tmp_dir/path-block")
  if [ "$old_present" = "1" ]; then
    [ "$expected_path_hash" = "$R_pathBlockSha256" ] ||
      fail "install directory differs from the installer-owned PATH receipt"
  fi
else
  expected_path_hash=none
fi

[ -n "${HOME:-}" ] ||
  fail "HOME is required to serialize installer changes to user state"
path_lock="$HOME/.sana-mcp-installer-path.lock"
if ! mkdir "$path_lock" 2>/dev/null; then
  fail "another sana-mcp installer is changing user state, or a stale lock needs removal: $path_lock"
fi
path_lock_created=1
path_lock_token=$(mktemp "$path_lock/owner.XXXXXX") || {
  cleanup_unowned_path_lock_artifacts || :
  fail "could not establish ownership of the per-user installer lock"
}
path_lock_token_created=1
path_lock_value=${path_lock_token##*/}
if ! printf '%s\n' "$path_lock_value" > "$path_lock_token"; then
  cleanup_unowned_path_lock_artifacts || :
  fail "could not record ownership of the per-user installer lock"
fi
path_lock_acquired=1

transaction_active=1
if [ "$old_was_running" = "1" ]; then
  assert_installer_locks_owned
  "$dest" __lifecycle stop --format properties > "$tmp_dir/lifecycle.properties" ||
    fail "existing daemon could not be stopped safely"
  read_lifecycle "$tmp_dir/lifecycle.properties"
  [ "$L_state" = "stopped" ] || fail "existing daemon did not stop"
fi

staged_binary=$(mktemp "$install_dir/.sana-mcp.XXXXXX") ||
  fail "could not stage the binary in $install_dir"
cp "$tmp_dir/binary" "$staged_binary"
chmod 755 "$staged_binary"
assert_installer_locks_owned
mv -f "$staged_binary" "$dest"
staged_binary=""

verify_or_apply_path_block "$path_profile"
if [ "$current_shell_path_profile" = "none" ]; then
  printf "PATH was not changed because no matching shell startup file exists.\n"
  printf "Add %s to PATH manually, or run the binary by its absolute path.\n" "$install_dir"
elif [ "$path_profile" != "$current_shell_path_profile" ]; then
  printf "PATH was not changed for the current shell because the installer-owned PATH block belongs to a different shell startup file.\n"
  printf "Add %s to PATH manually, or run the binary by its absolute path.\n" "$install_dir"
fi
PATH="$install_dir:${PATH:-}"; export PATH

{
  printf '%s\n' 'format=sana-mcp-install-v2'
  printf 'version=%s\n' "$P_packageVersion"
  printf 'target=%s\n' "$P_target"
  printf 'sourceCommit=%s\n' "$P_sourceCommit"
  printf 'binarySha256=%s\n' "$P_sha256"
  printf 'pathProfile=%s\n' "$path_profile"
  printf 'pathBlockSha256=%s\n' "$expected_path_hash"
  printf 'installerProtocol=%s\n' "$P_installerProtocol"
  printf 'lifecycleProtocol=%s\n' "$P_lifecycleProtocol"
  printf 'inspectProtocol=%s\n' "$P_inspectProtocol"
  printf 'stateCompatibility=%s\n' "$P_stateCompatibility"
} > "$tmp_dir/new-receipt"
staged_receipt=$(mktemp "$install_dir/.sana-mcp-receipt.XXXXXX") ||
  fail "could not stage the installer receipt in $install_dir"
cp "$tmp_dir/new-receipt" "$staged_receipt"
chmod 600 "$staged_receipt"
revalidate_path_block_for_commit "$path_profile"
assert_installer_locks_owned
mv -f "$staged_receipt" "$receipt"
staged_receipt=""

if [ "$old_present" = "0" ]; then
  config_journal_dir="$install_dir/.sana-mcp-config-transaction"
  config_journal_file="$config_journal_dir/client-config-transaction.json"
  [ ! -L "$config_journal_dir" ] ||
    fail "client configuration journal directory must not be a symbolic link"
  if [ -e "$config_journal_file" ] || [ -L "$config_journal_file" ]; then
    config_journal_preexisting=1
  fi
fi
configure_status=0
config_interactive_attempted=0
if [ "$old_present" = "1" ]; then
  config_transaction_state=no-mutation
elif [ "${SANA_MCP_YES:-0}" = "1" ]; then
  live_state_touched=1
  assert_installer_locks_owned
  set +e
  "$dest" __configure-transaction apply \
    --journal "$config_journal_dir" \
    --server-command "$dest" \
    --yes > "$tmp_dir/config-apply.json"
  configure_status=$?
  set -e
elif { true >/dev/tty; } 2>/dev/null; then
  config_interactive_attempted=1
  live_state_touched=1
  assert_installer_locks_owned
  set +e
  "$dest" __configure-transaction apply \
    --journal "$config_journal_dir" \
    --server-command "$dest" \
    < /dev/tty > "$tmp_dir/config-apply.json"
  configure_status=$?
  set -e
else
  config_transaction_state=no-mutation
  printf '%s\n' "Client configuration was skipped because no interactive terminal is available."
  printf "Run this command: '%s' install\n" "$dest"
fi
if [ "$config_transaction_state" != "no-mutation" ]; then
  if ! read_config_transaction_result "$tmp_dir/config-apply.json" apply "$configure_status"; then
    retain_new_runtime=1
    preserve_tmp=1
    fail "client configuration returned an invalid transaction response (exit $configure_status); the replacement runtime and recovery files were retained"
  fi
  if [ "$configure_status" -eq 1 ] &&
    [ "$config_interactive_attempted" = "1" ] &&
    [ "$config_outcome" = "interaction-unavailable" ] &&
    [ "$applied_count" = "0" ] &&
    [ "$noop_count" = "0" ] &&
    [ "$config_disposition" = "interaction-unavailable" ] &&
    [ "$config_authentication" = "not-attempted" ] &&
    [ "$config_interaction_details" = "canonical" ] &&
    [ "$config_journal_field" = "absent" ] &&
    [ "$config_journal_preexisting" = "0" ] &&
    [ ! -e "$config_journal_file" ] &&
    [ ! -L "$config_journal_file" ]; then
    config_transaction_state=no-mutation
    printf '%s\n' "Client configuration was deferred because interactive controls are unavailable."
    printf "Run this command: '%s' install\n" "$dest"
  else
    report_authentication_state
    case "$configure_status:$config_outcome" in
    0:applied)
      if ! config_journal_is_regular; then
        retain_new_runtime=1
        preserve_tmp=1
        fail "client configuration reported applied changes without a usable recovery journal; the replacement runtime was retained"
      fi
      config_transaction_state=applied
      ;;
    0:no-mutation)
      if [ -e "$config_journal_file" ] || [ -L "$config_journal_file" ]; then
        retain_new_runtime=1
        preserve_tmp=1
        fail "client configuration reported no changes but left a recovery journal; the replacement runtime was retained"
      fi
      config_transaction_state=no-mutation
      ;;
    1:failed-rolled-back)
      config_transaction_state=safe-rolled-back
      assert_installer_locks_owned
      remove_completed_config_journal ||
        printf 'sana-mcp: client configuration was rolled back, but its completed journal could not be removed: %s\n' "$config_journal_dir" >&2
      preserve_tmp=1
      fail "client configuration did not complete, but its changes were rolled back; the replacement runtime remains installed because it has accessed live state"
      ;;
    1:interaction-unavailable|1:configuration-unavailable|1:authentication-incomplete|1:no-mutation)
      if [ "$config_journal_preexisting" = "1" ] ||
        { [ ! -e "$config_journal_file" ] && [ ! -L "$config_journal_file" ]; }; then
        config_transaction_state=no-mutation
        preserve_tmp=1
        fail "client configuration did not complete before changing client files; the replacement runtime remains installed because it has accessed live state"
      fi
      retain_new_runtime=1
      preserve_tmp=1
      fail "client configuration did not complete and may have changed client files; the replacement runtime and recovery journal were retained"
      ;;
    1:*)
      if [ "$config_journal_preexisting" = "1" ]; then
        config_transaction_state=no-mutation
        preserve_tmp=1
        fail "client configuration could not start while an existing recovery journal is present; the replacement runtime and existing journal were preserved"
      fi
      retain_new_runtime=1
      preserve_tmp=1
      fail "client configuration did not complete and its mutation state is uncertain; the replacement runtime and recovery journal were retained"
      ;;
    *)
      retain_new_runtime=1
      preserve_tmp=1
      fail "client configuration rollback status is uncertain (exit $configure_status, outcome $config_outcome); the replacement runtime and recovery journal were retained"
      ;;
    esac
  fi
fi

live_state_touched=1
assert_installer_locks_owned
if [ "$should_run_after_install" = "1" ]; then
  "$dest" __lifecycle start --format properties > "$tmp_dir/lifecycle.properties" ||
    fail "new daemon could not be restarted"
  read_lifecycle "$tmp_dir/lifecycle.properties"
  [ "$L_state" = "running" ] || fail "new daemon did not become healthy"
else
  "$dest" __lifecycle health --format properties > "$tmp_dir/lifecycle.properties" ||
    fail "new runtime health check failed"
  read_lifecycle "$tmp_dir/lifecycle.properties"
  if [ "$old_present" = "1" ] && [ "$L_state" = "running" ]; then
    "$dest" __lifecycle stop --format properties > "$tmp_dir/lifecycle.properties" ||
      fail "upgrade started a daemon that could not be stopped"
    read_lifecycle "$tmp_dir/lifecycle.properties"
    [ "$L_state" = "stopped" ] ||
      fail "upgrade did not preserve the previous stopped-daemon state"
  fi
fi

revalidate_path_block_for_commit "$path_profile"
assert_installer_locks_owned
committed=1
transaction_active=0
if [ "$config_transaction_state" = "applied" ]; then
  assert_installer_locks_owned
  if remove_completed_config_journal; then
    config_transaction_state=no-mutation
  else
    printf 'sana-mcp: install succeeded, but the completed configuration journal could not be removed: %s\n' "$config_journal_dir" >&2
  fi
fi
refresh_cleanup_lock_ownership ||
  fail "installer lock ownership was lost before final lock release"
release_path_lock ||
  fail "the owned per-user installer lock could not be released"
release_install_lock ||
  fail "the owned sana-mcp install lock could not be released"
printf '%s\n' 'sana-mcp installed.'
