'use client'
import { FormsList } from '@/components/dashboard/form/FormsList'
import { FormDetails } from '@/components/dashboard/form/FormDetails'
import { useParams } from 'next/navigation'
import React from 'react'

const DashboardPage = () => {
  const params = useParams()
  const formId = params?.id as string | undefined

  return (
    <div className="container py-6">
      {formId ? (
        <FormDetails formId={formId} />
      ) : (
        <>
          <FormsList itemsPerPage={6} />
        </>
      )}
    </div>
  )
}

export default DashboardPage