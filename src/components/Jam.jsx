import React, { useState, useEffect, useCallback, useMemo } from 'react'
import * as rb from 'react-bootstrap'
import { useTranslation } from 'react-i18next'
import { Formik, useFormikContext } from 'formik'
import * as Api from '../libs/JmWalletApi'
import { useSettings } from '../context/SettingsContext'
import { useServiceInfo, useReloadServiceInfo } from '../context/ServiceInfoContext'
import { useCurrentWallet, useCurrentWalletInfo, useReloadCurrentWalletInfo } from '../context/WalletContext'
import { isDebugFeatureEnabled } from '../constants/debugFeatures'
import styles from './Jam.module.css'
import PageTitle from './PageTitle'
import ToggleSwitch from './ToggleSwitch'
import Sprite from './Sprite'
import Balance from './Balance'
import ScheduleProgress from './ScheduleProgress'

// When running the scheduler with internal destination addresses, the funds
// will end up on those 3 mixdepths (one UTXO each).
// Length of this array must be 3 for now.
const INTERNAL_DEST_ACCOUNTS = [0, 1, 2]
// Interval in milliseconds between requests to reload the schedule.
const SCHEDULE_REQUEST_INTERVAL = process.env.NODE_ENV === 'development' ? 10_000 : 60_000
const SCHEDULER_STOP_RESPONSE_DELAY_MS = 2_000

const ValuesListener = ({ handler }) => {
  const { values } = useFormikContext()

  useEffect(() => {
    if (values.dest1 !== '' && values.dest2 !== '' && values.dest3 !== '') {
      handler()
    }
  }, [values, handler])

  return null
}

export default function Jam() {
  const { t } = useTranslation()
  const settings = useSettings()
  const serviceInfo = useServiceInfo()
  const reloadServiceInfo = useReloadServiceInfo()
  const wallet = useCurrentWallet()
  const walletInfo = useCurrentWalletInfo()
  const reloadCurrentWalletInfo = useReloadCurrentWalletInfo()

  const [alert, setAlert] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [destinationIsExternal, setDestinationIsExternal] = useState(false)
  const [collaborativeOperationRunning, setCollaborativeOperationRunning] = useState(false)
  const [schedule, setSchedule] = useState(null)

  // Returns one fresh address for each requested mixdepth.
  const getNewAddressesForAccounts = useCallback(
    (mixdepths) => {
      if (mixdepths.length !== 3) {
        throw new Error('Can only handle 3 destination addresses for now.')
      }
      if (!walletInfo) {
        throw new Error('Wallet info is not available.')
      }
      return mixdepths.map((mixdepth) => {
        const externalBranch = walletInfo.data.display.walletinfo.accounts[mixdepth].branches.find((branch) => {
          return branch.branch.split('\t')[0] === 'external addresses'
        })

        const newEntry = externalBranch.entries.find((entry) => entry.status === 'new')

        if (!newEntry) {
          throw new Error(`Cannot find a fresh address in mixdepth ${mixdepth}`)
        }

        return newEntry.address
      })
    },
    [walletInfo]
  )

  const [useInsecureTestingSettings, setUseInsecureTestingSettings] = useState(false)

  const initialFormValues = useMemo(() => {
    const addressCount = 3

    let destinationAddresses = []
    if (destinationIsExternal) {
      // prefill with empty addresses
      destinationAddresses = Array(addressCount).fill('')
    } else {
      try {
        // prefill with addresses marked as "new"
        destinationAddresses = getNewAddressesForAccounts(INTERNAL_DEST_ACCOUNTS)
      } catch (e) {
        // on error initialize with empty addresses - form validation will do the rest
        destinationAddresses = Array(addressCount).fill('')
      }
    }

    return destinationAddresses.reduce((obj, addr, index) => ({ ...obj, [`dest${index + 1}`]: addr }), {})
  }, [destinationIsExternal, getNewAddressesForAccounts])

  useEffect(() => {
    const abortCtrl = new AbortController()

    setAlert(null)
    setIsLoading(true)

    const loadingServiceInfo = reloadServiceInfo({ signal: abortCtrl.signal }).catch((err) => {
      const message = err.message || t('send.error_loading_wallet_failed')
      !abortCtrl.signal.aborted && setAlert({ variant: 'danger', message })
    })

    const loadingWalletInfo = reloadCurrentWalletInfo({ signal: abortCtrl.signal }).catch((err) => {
      const message = err.message || t('send.error_loading_wallet_failed')
      !abortCtrl.signal.aborted && setAlert({ variant: 'danger', message })
    })

    Promise.all([loadingServiceInfo, loadingWalletInfo]).finally(() => !abortCtrl.signal.aborted && setIsLoading(false))

    return () => abortCtrl.abort()
  }, [reloadServiceInfo, reloadCurrentWalletInfo, t])

  useEffect(() => {
    const coinjoinInProgress = serviceInfo && serviceInfo.coinjoinInProgress
    const makerRunning = serviceInfo && serviceInfo.makerRunning

    setCollaborativeOperationRunning(coinjoinInProgress || makerRunning)
  }, [serviceInfo])

  const reloadSchedule = useCallback(
    ({ signal }) => {
      return Api.getSchedule({ walletName: wallet.name, token: wallet.token, signal })
        .then((res) => (res.ok ? res.json() : Api.Helper.throwError(res)))
        .then((data) => {
          if (!signal.aborted) {
            process.env.NODE_ENV === 'development' && console.log(data.schedule)
            setSchedule(data.schedule)
          }
        })
        .catch((err) => {
          if (err.response?.status === 404) {
            // Not finding a schedule is not an error.
            // It means a single collaborative transaction is running.
            // Those have no schedule.
            return
          }

          const message = err.message || t('scheduler.error_loading_schedule_failed')
          !signal.aborted && setAlert({ variant: 'danger', message })
        })
    },
    [wallet, t]
  )

  useEffect(() => {
    if (!collaborativeOperationRunning) {
      return
    }

    const abortCtrl = new AbortController()

    const load = () => {
      reloadSchedule({ signal: abortCtrl.signal }).catch((err) => console.error(err))
    }

    load()

    const interval = setInterval(load, SCHEDULE_REQUEST_INTERVAL)
    return () => {
      clearInterval(interval)
      abortCtrl.abort()
    }
  }, [collaborativeOperationRunning, reloadSchedule])

  const startSchedule = async (values) => {
    if (isLoading || collaborativeOperationRunning) {
      return
    }

    setAlert(null)
    setIsLoading(true)

    const destinations = [values.dest1, values.dest2, values.dest3]

    const body = { destination_addresses: destinations }

    // Make sure schedule testing is really only used in dev mode.
    if (isDebugFeatureEnabled('insecureScheduleTesting') && useInsecureTestingSettings) {
      body.tumbler_options = {
        addrcount: 3,
        minmakercount: 1,
        makercountrange: [1, 0],
        mixdepthcount: 3,
        mintxcount: 2,
        txcountparams: [1, 1],
        timelambda: 0.1,
        stage1_timelambda_increase: 1.0,
        liquiditywait: 10,
        waittime: 1.0,
        mixdepthsrc: 0,
      }
    }

    return Api.postSchedulerStart({ walletName: wallet.name, token: wallet.token }, body)
      .then((res) => (res.ok ? true : Api.Helper.throwError(res, t('scheduler.error_starting_schedule_failed'))))
      .then((_) => setCollaborativeOperationRunning(true))
      .catch((err) => {
        setAlert({ variant: 'danger', message: err.message })
      })
      .finally(() => setIsLoading(false))
  }

  const stopSchedule = async () => {
    if (isLoading || !collaborativeOperationRunning) {
      return
    }

    setAlert(null)
    setIsLoading(true)

    return Api.getSchedulerStop({ walletName: wallet.name, token: wallet.token })
      .then((res) => (res.ok ? true : Api.Helper.throwError(res, t('scheduler.error_stopping_schedule_failed'))))
      .then((_) => setCollaborativeOperationRunning(false))
      .then((_) => new Promise((r) => setTimeout(r, SCHEDULER_STOP_RESPONSE_DELAY_MS)))
      .catch((err) => {
        setAlert({ variant: 'danger', message: err.message })
      })
      .finally(() => setIsLoading(false))
  }

  return (
    <>
      <PageTitle title={t('scheduler.title')} subtitle={t('scheduler.subtitle')} />
      {alert && <rb.Alert variant={alert.variant}>{alert.message}</rb.Alert>}
      {isLoading ? (
        <rb.Placeholder as="div" animation="wave">
          <rb.Placeholder xs={12} className={styles['input-loader']} />
        </rb.Placeholder>
      ) : (
        <>
          {collaborativeOperationRunning && schedule && (
            <div className="mb-4">
              <ScheduleProgress schedule={schedule} />
            </div>
          )}
          {collaborativeOperationRunning && !schedule && (
            <rb.Alert variant="info" className="mb-4">
              {t('send.text_coinjoin_already_running')}
            </rb.Alert>
          )}
          {!collaborativeOperationRunning && wallet && walletInfo && (
            <>
              <div className="d-flex align-items-center justify-content-between mb-4">
                <div className="d-flex align-items-center gap-2">
                  <Sprite symbol="checkmark" width="25" height="25" className="text-secondary" />
                  <div className="d-flex flex-column">
                    <div>{t('scheduler.complete_wallet_title')}</div>
                    <div className={`text-secondary ${styles['small-text']}`}>
                      {t('scheduler.complete_wallet_subtitle')}
                    </div>
                  </div>
                </div>
                <>
                  {
                    // Todo: Subtract frozen or locked UTXOs from amount shown.
                  }
                  <Balance
                    valueString={walletInfo.data.display.walletinfo.total_balance}
                    convertToUnit={settings.unit}
                    showBalance={settings.showBalance}
                  />
                </>
              </div>
              <p className="text-secondary mb-4">{t('scheduler.description_destination_addresses')}</p>
            </>
          )}
          {((!collaborativeOperationRunning && walletInfo && serviceInfo) ||
            (collaborativeOperationRunning && schedule)) && (
            <Formik
              initialValues={initialFormValues}
              validate={(values) => {
                if (collaborativeOperationRunning) {
                  return {}
                }

                const errors = {}

                const isValidAddress = (candidate) => {
                  return typeof candidate !== 'undefined' && candidate !== ''
                }

                if (!isValidAddress(values.dest1)) {
                  errors.dest1 = t('scheduler.error_invalid_destionation_address')
                }
                if (!isValidAddress(values.dest2)) {
                  errors.dest2 = t('scheduler.error_invalid_destionation_address')
                }
                if (!isValidAddress(values.dest3)) {
                  errors.dest3 = t('scheduler.error_invalid_destionation_address')
                }

                const validAddresses = Array(3)
                  .fill('')
                  .map((_, index) => values[`dest${index + 1}`])
                  .filter((it) => isValidAddress(it))
                const uniqueValidAddresses = [...new Set(validAddresses)]
                if (validAddresses.length !== uniqueValidAddresses.length) {
                  errors.addressReuse = t('scheduler.error_address_reuse')
                }

                return errors
              }}
              onSubmit={async (values) => {
                if (collaborativeOperationRunning) {
                  await stopSchedule()
                } else {
                  await startSchedule(values)
                }
              }}
            >
              {({
                values,
                isSubmitting,
                handleSubmit,
                handleBlur,
                handleChange,
                setFieldValue,
                validateForm,
                isValid,
                dirty,
                touched,
                errors,
              }) => (
                <>
                  <ValuesListener handler={validateForm} />
                  <rb.Form onSubmit={handleSubmit} noValidate>
                    {!collaborativeOperationRunning && (
                      <>
                        <rb.Form.Group className="mb-4" controlId="offertype">
                          <ToggleSwitch
                            label={t('scheduler.toggle_internal_destination_title')}
                            subtitle={t('scheduler.toggle_internal_destination_subtitle')}
                            initialValue={destinationIsExternal}
                            onToggle={async (isToggled) => {
                              if (!isToggled) {
                                try {
                                  const newAddresses = getNewAddressesForAccounts(INTERNAL_DEST_ACCOUNTS)
                                  setFieldValue('dest1', newAddresses[0], true)
                                  setFieldValue('dest2', newAddresses[1], true)
                                  setFieldValue('dest3', newAddresses[2], true)
                                } catch (e) {
                                  console.error('Could not get internal addresses.', e)
                                  setFieldValue('dest1', '', true)
                                  setFieldValue('dest2', '', true)
                                  setFieldValue('dest3', '', true)
                                }
                              } else {
                                setFieldValue('dest1', '', false)
                                setFieldValue('dest2', '', false)
                                setFieldValue('dest3', '', false)
                              }

                              setDestinationIsExternal(isToggled)
                            }}
                            disabled={isSubmitting}
                          />
                        </rb.Form.Group>
                        {isDebugFeatureEnabled('insecureScheduleTesting') && (
                          <rb.Form.Group className="mb-4" controlId="offertype">
                            <ToggleSwitch
                              label={'Use insecure testing settings'}
                              subtitle={
                                "This is completely insecure but makes testing the schedule much faster. This option won't be available in production."
                              }
                              initialValue={useInsecureTestingSettings}
                              onToggle={(isToggled) => setUseInsecureTestingSettings(isToggled)}
                              disabled={isSubmitting}
                            />
                          </rb.Form.Group>
                        )}
                      </>
                    )}
                    {!collaborativeOperationRunning &&
                      destinationIsExternal &&
                      [1, 2, 3].map((i) => {
                        return (
                          <rb.Form.Group className="mb-4" key={i} controlId={`dest${i}`}>
                            <rb.Form.Label>{t('scheduler.label_destination_input', { destination: i })}</rb.Form.Label>
                            <rb.Form.Control
                              name={`dest${i}`}
                              value={values[`dest${i}`]}
                              placeholder={t('scheduler.placeholder_destination_input')}
                              onChange={handleChange}
                              onBlur={handleBlur}
                              isInvalid={touched[`dest${i}`] && !!errors[`dest${i}`]}
                              className={`${styles.input} slashed-zeroes`}
                            />
                          </rb.Form.Group>
                        )
                      })}
                    {errors && errors.addressReuse && <rb.Alert variant="danger">{errors.addressReuse}</rb.Alert>}
                    {!collaborativeOperationRunning && (
                      <p className="text-secondary mb-4">{t('scheduler.description_fees')}</p>
                    )}
                    <rb.Button
                      className={styles.submit}
                      variant="dark"
                      type="submit"
                      disabled={!collaborativeOperationRunning && (isSubmitting || isLoading || !isValid)}
                    >
                      <div className="d-flex justify-content-center align-items-center">
                        {collaborativeOperationRunning ? t('scheduler.button_stop') : t('scheduler.button_start')}
                      </div>
                    </rb.Button>
                  </rb.Form>
                </>
              )}
            </Formik>
          )}
        </>
      )}
    </>
  )
}