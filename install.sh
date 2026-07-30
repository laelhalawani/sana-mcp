#!/usr/bin/env sh
# Install the latest sana-mcp release:
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.sh | sh
# Pin a release:
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/latest/download/install.sh | SANA_MCP_VERSION=v0.4.20 sh
#   curl -fsSL https://github.com/laelhalawani/sana-mcp/releases/download/v0.4.20/install.sh | sh
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
retain_new_runtime=0
live_state_touched=0
download_pid=""
download_progress_pid=""
download_progress_active=0
setup_pid=""
setup_result_file=""
setup_transaction_active=0
config_journal_dir=""
config_journal_file=""

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

read_config_transaction_properties() {
  config_result_file=$1
  config_expected_operation=$2
  config_result_status=$3
  CT_format=""; CT_protocol=""; CT_operation=""; CT_outcome=""
  CT_applied=""; CT_noop=""; CT_journal=""; CT_disposition=""
  CT_authentication=""; CT_error=""; CT_seen=" "
  while IFS= read -r config_line || [ -n "$config_line" ]; do
    case "$config_line" in
      *=*) config_key=${config_line%%=*}; config_value=${config_line#*=} ;;
      *) return 1 ;;
    esac
    case "$CT_seen" in *" $config_key "*) return 1 ;; esac
    CT_seen="$CT_seen$config_key "
    case "$config_key" in
      format) CT_format=$config_value ;;
      transactionProtocol) CT_protocol=$config_value ;;
      operation) CT_operation=$config_value ;;
      outcome) CT_outcome=$config_value ;;
      appliedCount) CT_applied=$config_value ;;
      noopCount) CT_noop=$config_value ;;
      journal) CT_journal=$config_value ;;
      disposition) CT_disposition=$config_value ;;
      authentication) CT_authentication=$config_value ;;
      error) CT_error=$config_value ;;
      *) return 1 ;;
    esac
  done < "$config_result_file"
  [ "$CT_format" = "sana-mcp-config-transaction-v1" ] &&
    [ "$CT_protocol" = "1" ] &&
    [ "$CT_operation" = "$config_expected_operation" ] || return 1
  case "$CT_applied" in ''|*[!0-9]*) return 1 ;; esac
  case "$CT_noop" in ''|*[!0-9]*) return 1 ;; esac
  case "$CT_outcome" in
    applied|no-mutation|interaction-unavailable|configuration-unavailable|authentication-incomplete|failed-rolled-back|rollback-incomplete|conflict|journal-ambiguous|journal-persistence-unknown|journal-unavailable) ;;
    *) return 1 ;;
  esac
  case "$CT_journal" in present|absent) ;; *) return 1 ;; esac
  case "$CT_disposition" in
    absent|configured|no-clients|no-changes|cancelled|interaction-unavailable|configuration-unavailable|authentication-incomplete) ;;
    *) return 1 ;;
  esac
  case "$CT_authentication" in
    absent|not-attempted|ready|skipped|retained|unconfirmed) ;;
    *) return 1 ;;
  esac
  case "$CT_error" in present|absent) ;; *) return 1 ;; esac
  if [ "$config_expected_operation" = "apply" ]; then
    case "$config_result_status:$CT_outcome" in
      0:applied|0:no-mutation|1:interaction-unavailable|1:configuration-unavailable|1:authentication-incomplete|1:failed-rolled-back|1:journal-unavailable|2:rollback-incomplete|2:conflict|2:journal-ambiguous|2:journal-persistence-unknown) ;;
      *) return 1 ;;
    esac
    case "$config_result_status:$CT_outcome" in
      0:applied)
        [ "$CT_disposition" = "configured" ] &&
          { [ "$CT_authentication" = "ready" ] ||
            [ "$CT_authentication" = "skipped" ]; } || return 1
        ;;
      0:no-mutation)
        case "$CT_disposition" in no-clients|no-changes|cancelled) ;; *) return 1 ;; esac
        ;;
      1:failed-rolled-back)
        [ "$CT_applied" = "0" ] && [ "$CT_journal" = "present" ] &&
          [ "$CT_disposition" != "absent" ] &&
          [ "$CT_disposition" != "configured" ] &&
          [ "$CT_authentication" != "ready" ] || return 1
        ;;
    esac
  else
    case "$config_result_status:$CT_outcome" in
      0:failed-rolled-back|1:journal-unavailable|2:rollback-incomplete|2:conflict|2:journal-persistence-unknown) ;;
      *) return 1 ;;
    esac
  fi
  case "$config_result_status" in
    0) [ "$CT_error" = "absent" ] || return 1 ;;
    *) [ "$CT_error" = "present" ] || return 1 ;;
  esac
  if [ "$CT_outcome" = "applied" ]; then
    [ "$CT_applied" != "0" ] && [ "$CT_journal" = "present" ] || return 1
  elif [ "$CT_outcome" = "no-mutation" ]; then
    [ "$CT_applied" = "0" ] && [ "$CT_journal" = "absent" ] || return 1
  fi
}

remove_completed_config_journal() {
  if [ "$CT_journal" = "present" ]; then
    [ -f "$config_journal_file" ] && [ ! -L "$config_journal_file" ] || return 1
    [ -d "$config_journal_dir" ] && [ ! -L "$config_journal_dir" ] || return 1
    completed_config_sha256=$(hash_file "$config_journal_file") || return 1
    [ "${#completed_config_sha256}" -eq 64 ] || return 1
    case "$completed_config_sha256" in *[!a-f0-9]*) return 1 ;; esac
    completed_config_marker="$config_journal_dir/installer-completed.properties"
    [ ! -e "$completed_config_marker" ] && [ ! -L "$completed_config_marker" ] || return 1
    {
      printf '%s\n' 'format=sana-mcp-completed-config-v1'
      printf 'journalSha256=%s\n' "$completed_config_sha256"
    } > "$completed_config_marker" || {
      rm -f "$completed_config_marker" || :
      return 1
    }
    chmod 600 "$completed_config_marker" || return 1
    completed_config_dir=$(mktemp -d "$install_dir/.sana-mcp-config-completed.XXXXXX") || return 1
    rmdir "$completed_config_dir" || return 1
    mv "$config_journal_dir" "$completed_config_dir" || return 1
    remove_retired_config_directory "$completed_config_dir" || return 1
  else
    [ ! -e "$config_journal_dir" ] && [ ! -L "$config_journal_dir" ] || return 1
  fi
}

remove_retired_config_directory() {
  retired_config_dir=$1
  [ -d "$retired_config_dir" ] && [ ! -L "$retired_config_dir" ] || return 1
  retired_config_marker="$retired_config_dir/installer-completed.properties"
  retired_config_file="$retired_config_dir/client-config-transaction.json"
  [ -f "$retired_config_marker" ] && [ ! -L "$retired_config_marker" ] || return 1
  [ "$(wc -l < "$retired_config_marker" | tr -d '[:space:]')" = "2" ] || return 1
  IFS= read -r retired_format < "$retired_config_marker" || return 1
  retired_sha256=$(awk '
    NR == 2 && /^journalSha256=[a-f0-9][a-f0-9]*$/ {
      sub(/^journalSha256=/, "")
      print
    }
  ' "$retired_config_marker")
  [ "$retired_format" = "format=sana-mcp-completed-config-v1" ] &&
    [ "${#retired_sha256}" -eq 64 ] || return 1
  if [ -e "$retired_config_file" ] || [ -L "$retired_config_file" ]; then
    [ -f "$retired_config_file" ] && [ ! -L "$retired_config_file" ] &&
      [ "$(hash_file "$retired_config_file")" = "$retired_sha256" ] || return 1
    rm -f "$retired_config_file" || return 1
  fi
  rm -f "$retired_config_marker" || return 1
  rmdir "$retired_config_dir" || return 1
}

cleanup_completed_config_directories() {
  canonical_completed_marker="$config_journal_dir/installer-completed.properties"
  if [ -e "$canonical_completed_marker" ] || [ -L "$canonical_completed_marker" ]; then
    if ! remove_retired_config_directory "$config_journal_dir"; then
      rm -f "$canonical_completed_marker" || return 1
      if [ ! -e "$config_journal_file" ] && [ ! -L "$config_journal_file" ]; then
        rmdir "$config_journal_dir" || return 1
      fi
    fi
  fi
  completed_config_count=0
  for retained_config_dir in "$install_dir"/.sana-mcp-config-completed.*; do
    [ -e "$retained_config_dir" ] || [ -L "$retained_config_dir" ] || continue
    completed_config_count=$((completed_config_count + 1))
    [ "$completed_config_count" -le 32 ] || return 1
    if [ -d "$retained_config_dir" ] && [ ! -L "$retained_config_dir" ] &&
      [ ! -e "$retained_config_dir/installer-completed.properties" ] &&
      [ ! -L "$retained_config_dir/installer-completed.properties" ]; then
      rmdir "$retained_config_dir" || return 1
      continue
    fi
    remove_retired_config_directory "$retained_config_dir" || return 1
  done
}

resolve_interrupted_setup() {
  if [ -f "$config_journal_file" ] && [ ! -L "$config_journal_file" ]; then
    rollback_setup_transaction
  elif [ ! -e "$config_journal_dir" ] && [ ! -L "$config_journal_dir" ]; then
    return 0
  elif [ -d "$config_journal_dir" ] && [ ! -L "$config_journal_dir" ]; then
    rmdir "$config_journal_dir"
  else
    return 1
  fi
}

rollback_setup_transaction() {
  [ -n "$config_journal_dir" ] && [ -n "$config_journal_file" ] || return 1
  [ -f "$config_journal_file" ] && [ ! -L "$config_journal_file" ] || return 1
  rollback_result=$(mktemp "$install_dir/.sana-mcp-config-rollback.XXXXXX") || return 1
  setup_pid=""
  "$dest" __configure-transaction rollback \
    --journal "$config_journal_dir" \
    --format properties > "$rollback_result" 2>/dev/null &
  setup_pid=$!
  if wait "$setup_pid"; then
    rollback_status=0
  else
    rollback_status=$?
  fi
  setup_pid=""
  if read_config_transaction_properties "$rollback_result" rollback "$rollback_status" &&
    [ "$CT_outcome" = "failed-rolled-back" ] &&
    remove_completed_config_journal; then
    rollback_resolved=0
  else
    rollback_resolved=1
  fi
  rm -f "$rollback_result" || rollback_resolved=1
  return "$rollback_resolved"
}

finalize_committed_cleanup() {
  [ -n "$tmp_dir" ] || return 0
  rm -f \
    "$tmp_dir/bootstrap.properties" \
    "$tmp_dir/bootstrap.properties.sha256" \
    "$tmp_dir/release.properties" \
    "$tmp_dir/release.properties.sha256" \
    "$tmp_dir/manifest.json" \
    "$tmp_dir/manifest.json.sha256" \
    "$tmp_dir/binary" \
    "$tmp_dir/binary.sha256" \
    "$tmp_dir/binary-download.error" \
    "$tmp_dir/binary-download.done" \
    "$tmp_dir/inspect.properties" \
    "$tmp_dir/legacy-recovery.properties" \
    "$tmp_dir/old-binary" \
    "$tmp_dir/old-receipt" \
    "$tmp_dir/old-inspect.properties" \
    "$tmp_dir/lifecycle.properties" \
    "$tmp_dir/old-path-file" \
    "$tmp_dir/path-block" \
    "$tmp_dir/existing-path-block" \
    "$tmp_dir/path-without-block" \
    "$tmp_dir/new-receipt" || return 1
  rmdir "$tmp_dir" || return 1
  tmp_dir=""
}

cleanup() {
  cleanup_status=$?
  cleanup_failed=0
  cleanup_error_summary=""
  set +e
  if [ -n "$download_pid" ]; then
    kill "$download_pid" 2>/dev/null || :
    wait "$download_pid" 2>/dev/null || :
    download_pid=""
  fi
  if [ -n "$download_progress_pid" ]; then
    kill "$download_progress_pid" 2>/dev/null || :
    wait "$download_progress_pid" 2>/dev/null || :
    download_progress_pid=""
  fi
  if [ -n "$setup_pid" ]; then
    kill "$setup_pid" 2>/dev/null || :
    wait "$setup_pid" 2>/dev/null || :
    setup_pid=""
  fi
  if [ "$setup_transaction_active" = "1" ]; then
    if ! resolve_interrupted_setup; then
      printf 'sana-mcp: setup recovery is incomplete; rerun the installer.\n' >&2
    fi
    setup_transaction_active=0
  fi
  if [ -n "$setup_result_file" ]; then
    rm -f "$setup_result_file" || :
    setup_result_file=""
  fi
  if [ "$download_progress_active" = "1" ]; then
    if [ "$host_color" = "1" ]; then
      printf '%s\n' "$color_reset"
    else
      printf '\n'
    fi
    download_progress_active=0
  fi
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
          installer_fsync file "$rollback_binary" &&
          refresh_cleanup_lock_ownership &&
          mv -f "$rollback_binary" "$dest" &&
          refresh_cleanup_lock_ownership &&
          cp "$tmp_dir/old-receipt" "$rollback_receipt" &&
          refresh_cleanup_lock_ownership &&
          chmod 600 "$rollback_receipt" &&
          refresh_cleanup_lock_ownership &&
          installer_fsync file "$rollback_receipt" &&
          refresh_cleanup_lock_ownership &&
          mv -f "$rollback_receipt" "$receipt" &&
          refresh_cleanup_lock_ownership &&
          installer_fsync directory "$install_dir"; then
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
        if [ "$files_restored" = "1" ]; then
          refresh_cleanup_lock_ownership &&
            installer_fsync directory "$install_dir" || {
            rollback_errors=1
            files_restored=0
          }
        fi
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
              installer_fsync file "$rollback_path" &&
              [ "$(hash_file "$path_file")" = "$path_written_sha256" ] &&
              refresh_cleanup_lock_ownership &&
              mv -f "$rollback_path" "$path_file"; then
              staged_path=""
              refresh_cleanup_lock_ownership || :
              if [ "$cleanup_lock_ownership_lost" = "0" ]; then
                installer_fsync file "$path_file" || rollback_errors=1
              fi
            else
              rollback_errors=1
            fi
          else
            refresh_cleanup_lock_ownership &&
              rm -f "$path_file" || rollback_errors=1
            refresh_cleanup_lock_ownership || :
            if [ "$cleanup_lock_ownership_lost" = "0" ]; then
              installer_fsync directory "$(dirname "$path_file")" || rollback_errors=1
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
         "$tmp_dir/binary-download.error" \
         "$tmp_dir/binary-download.done" \
         "$tmp_dir/inspect.properties" \
         "$tmp_dir/legacy-recovery.properties"; then
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
        "$tmp_dir/new-receipt"; then
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

host_color=0
host_control=0
if [ -t 1 ] && [ "${TERM:-}" != "dumb" ] && [ -z "${CI:-}" ]; then
  host_control=1
  if [ -z "${NO_COLOR+x}" ]; then
    host_color=1
  fi
fi
color_cyan=$(printf '\033[36m')
color_gray=$(printf '\033[90m')
color_white=$(printf '\033[37m')
color_green=$(printf '\033[32m')
color_reset=$(printf '\033[0m')

host_line() {
  host_line_color=$1
  host_line_text=$2
  if [ "$host_color" = "1" ]; then
    printf '%s%s%s\n' "$host_line_color" "$host_line_text" "$color_reset"
  else
    printf '%s\n' "$host_line_text"
  fi
}

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
  download_url=$1
  download_destination=$2
  download_total=$(
    curl -fIL \
      --proto '=https' \
      --proto-redir '=https' \
      --max-redirs 5 \
      --connect-timeout 3 \
      --max-time 5 \
      --silent \
      --show-error \
      "$download_url" 2>/dev/null |
      awk '
        BEGIN { size = 0 }
        toupper($1) ~ /^HTTP\// { size = 0 }
        tolower($1) == "content-length:" {
          value = $2
          sub(/\r$/, "", value)
          if (value ~ /^[0-9]+$/) size = value
        }
        END { print size }
      '
  ) || download_total=0
  case "$download_total" in
    ''|*[!0-9]*) download_total=0 ;;
  esac

  : > "$download_destination"
  rm -f "$tmp_dir/binary-download.done"
  download_started=$(date +%s)
  curl -fL \
    --proto '=https' \
    --proto-redir '=https' \
    --max-redirs 5 \
    --connect-timeout 15 \
    --max-time 600 \
    --retry 2 \
    --retry-delay 1 \
    --silent \
    --show-error \
    "$download_url" \
    -o "$download_destination" \
    2> "$tmp_dir/binary-download.error" &
  download_pid=$!

  if [ -t 1 ]; then
    (
      while [ ! -f "$tmp_dir/binary-download.done" ]; do
        download_now=$(date +%s)
        download_read=$(wc -c < "$download_destination" | tr -d '[:space:]')
        format_download_progress "$download_read" "$download_total" "$((download_now - download_started))" "$color_cyan" || exit 1
        sleep 0.1
      done
    ) &
    download_progress_pid=$!
    download_progress_active=1
  fi

  if wait "$download_pid"; then
    download_status=0
  else
    download_status=$?
  fi
  download_pid=""
  : > "$tmp_dir/binary-download.done"
  if [ -n "$download_progress_pid" ]; then
    wait "$download_progress_pid" 2>/dev/null || :
    download_progress_pid=""
  fi
  download_read=$(wc -c < "$download_destination" | tr -d '[:space:]')
  download_now=$(date +%s)
  if [ "$download_status" -eq 0 ]; then
    format_download_progress "$download_read" "$download_total" "$((download_now - download_started))" "$color_green" || return 1
    printf '\n'
    download_progress_active=0
    return 0
  fi
  if [ "$download_progress_active" = "1" ]; then
    if [ "$host_color" = "1" ]; then
      printf '%s\n' "$color_reset"
    else
      printf '\n'
    fi
    download_progress_active=0
  fi
  if [ -s "$tmp_dir/binary-download.error" ]; then
    while IFS= read -r download_error_line || [ -n "$download_error_line" ]; do
      printf '%s\n' "$download_error_line" >&2
    done < "$tmp_dir/binary-download.error"
  fi
  return "$download_status"
}

format_download_progress() {
  progress_read=$1
  progress_total=$2
  progress_elapsed=$3
  progress_color=$4
  if ! progress_text=$(LC_ALL=C awk \
    -v bytes="$progress_read" \
    -v total="$progress_total" \
    -v elapsed="$progress_elapsed" '
    function decimal(value, text) {
      text = sprintf("%.1f", value)
      sub(/\.0$/, "", text)
      return text
    }
    BEGIN {
      if (elapsed < 0.001) elapsed = 0.001
      speed = bytes / elapsed
      read_mb = decimal(bytes / 1048576)
      speed_mb = decimal(speed / 1048576)
      if (total <= 0) {
        printf "  %s MB  %s MB/s", read_mb, speed_mb
        exit
      }
      ratio = bytes / total
      if (ratio < 0) ratio = 0
      if (ratio > 1) ratio = 1
      percent = int(ratio * 100)
      total_mb = decimal(total / 1048576)
      while (length(read_mb) < length(total_mb)) read_mb = " " read_mb
      remaining = speed > 0 ? (total - bytes) / speed : 0
      if (remaining < 0) remaining = 0
      minutes = int(remaining / 60) % 60
      seconds = int(remaining) % 60
      fill = int(ratio * 24)
      bar = ""
      for (position = 0; position < 24; position++) {
        bar = bar (position < fill ? "#" : "-")
      }
      printf "  [%s] %3d%%  %s/%s MB  %s MB/s  ETA %02d:%02d", \
        bar, percent, read_mb, total_mb, speed_mb, minutes, seconds
    }
  '); then
    return 1
  fi
  if [ -t 1 ]; then
    if [ "$host_color" = "1" ]; then
      printf '\r%s%s%s \033[K' "$progress_color" "$progress_text" "$color_reset"
    elif [ "$host_control" = "1" ]; then
      printf '\r%s \033[K' "$progress_text"
    else
      printf '\r%s ' "$progress_text"
    fi
  else
    printf '%s' "$progress_text"
  fi
}

installer_fsync() {
  fsync_kind=$1
  fsync_path=$2
  "$tmp_dir/binary" __installer-fsync "$fsync_kind" --path "$fsync_path"
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
  [ "$P_semanticCapability" = "bundled" ] || fail "unsupported binary capability"
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

read_legacy_recovery_result() {
  legacy_result_file=$1
  LR_format=""; LR_status=""; LR_fingerprint=""; LR_phase=""
  LR_code=""; LR_messageBase64=""; LR_recoveredCount=""; LR_seen=" "
  while IFS= read -r legacy_line || [ -n "$legacy_line" ]; do
    [ -n "$legacy_line" ] || continue
    case "$legacy_line" in
      *=*) legacy_key=${legacy_line%%=*}; legacy_value=${legacy_line#*=} ;;
      *) fail "legacy installer recovery returned malformed state" ;;
    esac
    case "$LR_seen" in
      *" $legacy_key "*) fail "legacy installer recovery repeated $legacy_key" ;;
    esac
    LR_seen="${LR_seen}${legacy_key} "
    case "$legacy_key" in
      format|status|phase|code)
        case "$legacy_value" in
          ""|*[!A-Za-z0-9._+-]*) fail "legacy installer recovery returned invalid $legacy_key" ;;
        esac
        ;;
      fingerprint)
        [ "${#legacy_value}" -eq 64 ] || fail "legacy installer recovery returned an invalid fingerprint"
        case "$legacy_value" in *[!a-f0-9]*) fail "legacy installer recovery returned an invalid fingerprint" ;; esac
        ;;
      messageBase64)
        case "$legacy_value" in *[!A-Za-z0-9+/=]*) fail "legacy installer recovery returned an invalid message" ;; esac
        ;;
      recoveredCount)
        case "$legacy_value" in ""|*[!0-9]*) fail "legacy installer recovery returned an invalid count" ;; esac
        ;;
      *) fail "legacy installer recovery returned an unknown field" ;;
    esac
    case "$legacy_key" in
      format) LR_format=$legacy_value ;;
      status) LR_status=$legacy_value ;;
      fingerprint) LR_fingerprint=$legacy_value ;;
      phase) LR_phase=$legacy_value ;;
      code) LR_code=$legacy_value ;;
      messageBase64) LR_messageBase64=$legacy_value ;;
      recoveredCount) LR_recoveredCount=$legacy_value ;;
    esac
  done < "$legacy_result_file"
  [ "$LR_format" = "sana-mcp-legacy-posix-recovery-result-v1" ] ||
    fail "legacy installer recovery protocol is unsupported"
  case "$LR_status" in
    none)
      [ "$LR_seen" = " format status " ] || fail "legacy installer recovery state is contradictory"
      ;;
    confirmation-required)
      [ -n "$LR_fingerprint" ] && [ "$LR_seen" = " format status fingerprint " ] ||
        fail "legacy installer recovery confirmation state is incomplete"
      ;;
    pending)
      [ -n "$LR_fingerprint" ] && [ -n "$LR_phase" ] &&
        [ "$LR_seen" = " format status fingerprint phase " ] ||
        fail "legacy installer recovery journal state is incomplete"
      ;;
    completed)
      [ -n "$LR_fingerprint" ] && [ "$LR_recoveredCount" = "4" ] &&
        [ "$LR_seen" = " format status fingerprint recoveredCount " ] ||
        fail "legacy installer recovery completion state is incomplete"
      ;;
    blocked|error)
      [ -n "$LR_code" ] && [ -n "$LR_messageBase64" ] &&
        [ "$LR_seen" = " format status code messageBase64 " ] ||
        fail "legacy installer recovery failure state is incomplete"
      ;;
    *) fail "legacy installer recovery returned an unknown status" ;;
  esac
}

recover_legacy_interrupted_install() {
  legacy_path_lock="$HOME/.sana-mcp-installer-path.lock"
  legacy_journal="$HOME/.sana-mcp-legacy-posix-recovery.json"
  legacy_journal_temporary="$legacy_journal.tmp"
  if [ ! -d "$install_lock" ] && [ ! -d "$legacy_path_lock" ] &&
    [ ! -f "$legacy_journal" ] && [ ! -f "$legacy_journal_temporary" ]; then
    return 0
  fi
  legacy_result="$tmp_dir/legacy-recovery.properties"
  "$tmp_dir/binary" __recover-legacy-posix inspect \
    --home "$HOME" --install-dir "$install_dir" > "$legacy_result" ||
    fail "legacy installer recovery inspection failed"
  read_legacy_recovery_result "$legacy_result"
  case "$LR_status" in
    none) return 0 ;;
    blocked|error)
      fail "interrupted installer recovery was refused safely ($LR_code)"
      ;;
    pending)
      legacy_fingerprint=""
      ;;
    confirmation-required)
      legacy_fingerprint=$LR_fingerprint
      legacy_approved=0
      if [ "${SANA_MCP_RECOVER_INTERRUPTED:-0}" = "1" ]; then
        legacy_approved=1
      elif { true </dev/tty >/dev/tty; } 2>/dev/null; then
        printf 'An interrupted sana-mcp install was detected. Stop it and continue? [y/N] ' > /dev/tty
        IFS= read -r legacy_answer < /dev/tty || legacy_answer=""
        case "$legacy_answer" in y|Y|yes|YES|Yes) legacy_approved=1 ;; esac
      else
        fail "interrupted installer recovery requires confirmation in a terminal"
      fi
      if [ "$legacy_approved" != "1" ]; then
        host_line "$color_gray" "Interrupted install recovery cancelled."
        exit 0
      fi
      ;;
  esac
  if [ -n "$legacy_fingerprint" ]; then
    "$tmp_dir/binary" __recover-legacy-posix recover \
      --home "$HOME" --install-dir "$install_dir" \
      --fingerprint "$legacy_fingerprint" > "$legacy_result" ||
      fail "interrupted installer recovery failed"
  else
    "$tmp_dir/binary" __recover-legacy-posix recover \
      --home "$HOME" --install-dir "$install_dir" > "$legacy_result" ||
      fail "interrupted installer recovery failed"
  fi
  read_legacy_recovery_result "$legacy_result"
  [ "$LR_status" = "completed" ] ||
    fail "interrupted installer recovery did not complete ($LR_code)"
  host_line "$color_gray" "  Recovered an interrupted install."
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
    [ "$I_stateCompatibility" = "$expected_state_compatibility" ] ||
    fail "binary identity does not match its authoritative release metadata"
  case "$inspect_context:$I_semanticCapability" in
    release:bundled|receipt:keyword|receipt:bundled) ;;
    *) fail "binary semantic capability does not match its authoritative context" ;;
  esac
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
  installer_fsync file "$staged_path"

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
  installer_fsync file "$path_file"
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

if [ "${libc:-}" = "musl" ]; then
  case "$machine" in
    x64) glibc_compat_loader=/lib/ld-linux-x86-64.so.2 ;;
    arm64) glibc_compat_loader=/lib/ld-linux-aarch64.so.1 ;;
    *) fail "unsupported musl architecture: $machine" ;;
  esac
  if command -v apk >/dev/null 2>&1; then
    if ! apk info --exists libstdc++ >/dev/null 2>&1 ||
      ! apk info --exists libgcc >/dev/null 2>&1 ||
      ! apk info --exists gcompat >/dev/null 2>&1; then
      fail "Alpine requires the libstdc++, libgcc, and gcompat runtime packages. Run: apk add --no-cache libstdc++ libgcc gcompat. Then rerun this installer."
    fi
  elif [ ! -e "$glibc_compat_loader" ]; then
    fail "This musl system requires a glibc compatibility runtime providing $glibc_compat_loader for bundled semantic search. Install the distribution's compatibility runtime and rerun this installer."
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
printf '\n'
host_line "$color_cyan" "Installing sana-mcp $version"
host_line "$color_gray" "  Platform: $target"
host_line "$color_white" "  Downloading verified binary..."

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
if [ "$os" = "Linux" ] && [ -n "${HOME:-}" ]; then
  recover_legacy_interrupted_install
fi
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
  "$dest" __lifecycle health --format properties --allow-stale-running > "$tmp_dir/lifecycle.properties" ||
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
installer_fsync file "$staged_binary"
assert_installer_locks_owned
mv -f "$staged_binary" "$dest"
staged_binary=""

verify_or_apply_path_block "$path_profile"
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
installer_fsync file "$staged_receipt"
revalidate_path_block_for_commit "$path_profile"
assert_installer_locks_owned
mv -f "$staged_receipt" "$receipt"
staged_receipt=""
installer_fsync directory "$install_dir"

assert_installer_locks_owned
live_state_touched=1
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
refresh_cleanup_lock_ownership ||
  fail "installer lock ownership was lost before final lock release"
release_path_lock ||
  fail "the owned per-user installer lock could not be released"
release_install_lock ||
  fail "the owned sana-mcp install lock could not be released"
finalize_committed_cleanup || fail "cleanup was incomplete"

if [ "${SANA_MCP_UPDATE:-0}" != "1" ]; then
  setup_status=0
  setup_recovery_incomplete=0
  config_journal_dir="$install_dir/.sana-mcp-config-transaction"
  config_journal_file="$config_journal_dir/client-config-transaction.json"
  if ! cleanup_completed_config_directories; then
    setup_status=1
    setup_recovery_incomplete=1
  fi
  if [ "$setup_recovery_incomplete" = "0" ] &&
    { [ -e "$config_journal_dir" ] || [ -L "$config_journal_dir" ]; }; then
    if ! rollback_setup_transaction; then
      setup_status=1
      setup_recovery_incomplete=1
    fi
  fi
  if [ "$setup_recovery_incomplete" = "0" ]; then
    setup_result_file=$(mktemp "$install_dir/.sana-mcp-config-result.XXXXXX") ||
      setup_recovery_incomplete=1
  fi
  if [ "$setup_recovery_incomplete" = "0" ]; then
    setup_transaction_active=1
    if [ "${SANA_MCP_YES:-0}" = "1" ]; then
      "$dest" __configure-transaction apply \
        --journal "$config_journal_dir" \
        --server-command "$dest" \
        --format properties \
        --yes > "$setup_result_file" &
    elif { true </dev/tty >/dev/tty; } 2>/dev/null; then
      "$dest" __configure-transaction apply \
        --journal "$config_journal_dir" \
        --server-command "$dest" \
        --format properties \
        < /dev/tty > "$setup_result_file" 2> /dev/tty &
    else
      "$dest" __configure-transaction apply \
        --journal "$config_journal_dir" \
        --server-command "$dest" \
        --format properties \
        < /dev/null > "$setup_result_file" &
    fi
    setup_pid=$!
    if wait "$setup_pid"; then
      setup_status=0
    else
      setup_status=$?
    fi
    setup_pid=""
    setup_transaction_active=0
    if read_config_transaction_properties "$setup_result_file" apply "$setup_status"; then
      if [ "$CT_journal" = "present" ]; then
        case "$CT_outcome" in
          applied)
            remove_completed_config_journal || setup_recovery_incomplete=1
            ;;
          *)
            rollback_setup_transaction || setup_recovery_incomplete=1
            ;;
        esac
      else
        remove_completed_config_journal || setup_recovery_incomplete=1
      fi
    else
      setup_status=1
      if [ -e "$config_journal_dir" ] || [ -L "$config_journal_dir" ]; then
        rollback_setup_transaction || setup_recovery_incomplete=1
      fi
    fi
    rm -f "$setup_result_file" || setup_recovery_incomplete=1
    setup_result_file=""
  fi
  if [ "$setup_recovery_incomplete" = "1" ]; then
    printf 'sana-mcp: setup recovery is incomplete; rerun the installer.\n' >&2
  elif [ "$setup_status" -ne 0 ]; then
    if [ "${SANA_MCP_YES:-0}" = "1" ]; then
      printf 'sana-mcp: installation succeeded, but client registration exited with code %s.\n' "$setup_status" >&2
      printf "sana-mcp: retry with: '%s' install --yes\n" "$dest" >&2
    else
      printf 'sana-mcp: installation succeeded, but setup exited with code %s.\n' "$setup_status" >&2
      printf "sana-mcp: retry with: '%s' install\n" "$dest" >&2
    fi
  fi
fi
